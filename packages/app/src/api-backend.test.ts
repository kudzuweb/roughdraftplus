import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiBackend } from "./api-backend";
import { ServerInstanceGoneError } from "./storage";

function createBackend() {
  return new ApiBackend({
    kind: "local-files",
    label: "Local files",
    detail: "/work",
    projectPath: "/work",
    serverInstanceId: "instance-1",
  });
}

function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("ApiBackend", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the server instance id with markdown writes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "draft",
            title: "Draft",
            content: "# Draft\n",
            version: "v2",
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await createBackend().saveMarkdownFile("draft.md", "# Draft\n", "v1");

    expect(lastRequestBody(fetchMock)).toMatchObject({
      content: "# Draft\n",
      expectedVersion: "v1",
      serverInstanceId: "instance-1",
    });
  });

  it("reports a replaced server instead of a generic save failure", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "gone" }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(
      createBackend().saveMarkdownFile("draft.md", "# Draft\n", "v1"),
    ).rejects.toBeInstanceOf(ServerInstanceGoneError);
  });

  it("sends the server instance id with review handoffs", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ delivered: true }), { status: 201 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await createBackend().completeReview("draft.md", {
      overallComment: "Looks good.",
    });

    expect(lastRequestBody(fetchMock)).toMatchObject({
      path: "draft.md",
      overallComment: "Looks good.",
      serverInstanceId: "instance-1",
    });
  });

  it("reports a replaced server when the review handoff is refused", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "gone" }), { status: 410 }),
    ) as unknown as typeof fetch;

    await expect(
      createBackend().completeReview("draft.md"),
    ).rejects.toBeInstanceOf(ServerInstanceGoneError);
  });
});
