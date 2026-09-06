import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { detectBackend } from "./detect-backend";
import { LocalStorageBackend } from "./local-storage-backend";
import { RemoteBackend } from "./remote-backend";

describe("detectBackend", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("creates a remote backend when the URL has a session and the server supports remote documents", async () => {
    window.history.replaceState(null, "", "/?session=session-1&token=secret");
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            backend: "local-files",
            capabilities: { remoteDocuments: true },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const remoteBackend = new RemoteBackend(
      {
        kind: "remote",
        label: "Remote document",
        detail: "draft.md",
        sessionId: "session-1",
        originPath: "/work/draft.md",
      },
      {
        id: "session-1",
        originPath: "/work/draft.md",
        content: "content",
        version: "version-1",
      },
    );
    const createRemoteBackend = vi
      .spyOn(RemoteBackend, "create")
      .mockResolvedValue(remoteBackend);

    await expect(detectBackend()).resolves.toBe(remoteBackend);
    expect(createRemoteBackend).toHaveBeenCalledWith("session-1", "secret");
  });

  it("falls back to the API backend when a session URL points at a server without remote-document support", async () => {
    window.history.replaceState(null, "", "/?session=session-1");
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            backend: "local-files",
            projectDir: "/work",
            capabilities: {},
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const createRemoteBackend = vi.spyOn(RemoteBackend, "create");

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(ApiBackend);
    expect(backend.info.kind).toBe("local-files");
    expect(createRemoteBackend).not.toHaveBeenCalled();
  });

  it("records the server instance id so later writes can prove which server the tab loaded from", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            backend: "local-files",
            projectDir: "/work",
            instanceId: "instance-1",
            capabilities: {},
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(ApiBackend);
    expect(backend.info.serverInstanceId).toBe("instance-1");
  });

  it("does not hide a broken remote session by falling back to local storage", async () => {
    window.history.replaceState(null, "", "/?session=missing&token=bad");
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            backend: "local-files",
            capabilities: { remoteDocuments: true },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    vi.spyOn(RemoteBackend, "create").mockRejectedValue(
      new Error("Could not load remote document session missing: 404"),
    );

    await expect(detectBackend()).rejects.toThrow(
      /Could not load remote document session/,
    );
  });

  it("uses local storage when no server is available", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const backend = await detectBackend();

    expect(backend).toBeInstanceOf(LocalStorageBackend);
  });
});
