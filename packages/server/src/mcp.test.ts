import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";
import { callTool } from "./mcp";

interface WatchScriptResponse {
  events?: unknown[];
  timedOut?: boolean;
  nextSequence?: number;
}

describe("mcp", () => {
  let tempDir: string;
  let stateFile: string;
  let projectDir: string;
  let documentPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "roughdraft-mcp-"));
    projectDir = path.join(tempDir, "project");
    stateFile = path.join(tempDir, "state", "server.json");
    documentPath = path.join(projectDir, "draft.md");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(documentPath, "# Draft\n");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://localhost:7373", port: 7373 }),
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Scripted watch responses, one per request; an Error entry is thrown as a
  // fetch failure. `segmentDelayMs` makes a polling segment take real time, so
  // an overall deadline can expire across segments.
  function createWatchScriptFetch(
    script: Array<Error | WatchScriptResponse>,
    segmentDelayMs = 0,
  ) {
    const requestBodies: Array<Record<string, unknown>> = [];
    const remaining = [...script];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requestBodies.push(body);
      if (segmentDelayMs > 0 && body.timeoutSeconds !== 0) {
        await delay(segmentDelayMs);
      }
      const next = remaining.shift();
      if (!next) {
        throw new Error("watch script exhausted: unexpected extra request");
      }
      if (next instanceof Error) throw next;
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchImpl, requestBodies };
  }

  it("targets the watched document and bounds every request it sends", async () => {
    const { fetchImpl, requestBodies } = createWatchScriptFetch([
      { events: [], timedOut: false, nextSequence: 1 },
    ]);

    await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(requestBodies[0]).toMatchObject({
      projectPath: projectDir,
      path: "draft.md",
      batchWindowSeconds: 0.25,
      fromNow: true,
    });
    for (const body of requestBodies) {
      expect(typeof body.timeoutSeconds).toBe("number");
      expect(body.timeoutSeconds).toBeLessThanOrEqual(240);
    }
  });

  it("keeps polling when a watch outlives one segment", async () => {
    const { fetchImpl, requestBodies } = createWatchScriptFetch([
      { events: [], timedOut: true, nextSequence: 5 },
      { events: [], timedOut: true, nextSequence: 5 },
      {
        events: [{ documentPath, type: "review.completed" }],
        timedOut: false,
        nextSequence: 6,
      },
    ]);

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      timedOut: false,
      events: [{ type: "review.completed" }],
    });
    expect(requestBodies).toHaveLength(3);
    // The cursor carries across the gap, so an event emitted between segments
    // is still delivered.
    expect(requestBodies[1]).toMatchObject({
      fromNow: false,
      afterSequence: 4,
    });
  });

  it("keeps polling when a segment dies at undici's headers timeout", async () => {
    const { fetchImpl } = createWatchScriptFetch([
      { events: [], timedOut: true, nextSequence: 1 },
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
      }),
      {
        events: [{ documentPath, type: "review.completed" }],
        timedOut: false,
        nextSequence: 2,
      },
    ]);

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({ timedOut: false });
  });

  it("gives up at an explicit timeoutSeconds instead of polling on", async () => {
    const { fetchImpl, requestBodies } = createWatchScriptFetch(
      [
        { events: [], timedOut: true, nextSequence: 1 },
        { events: [], timedOut: true, nextSequence: 1 },
        { events: [], timedOut: true, nextSequence: 1 },
        { events: [], timedOut: true, nextSequence: 1 },
      ],
      300,
    );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir, timeoutSeconds: 0.5 },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({ timedOut: true });
    // The priming poll plus at least one segment, then the deadline ends it
    // rather than the script running out.
    expect(requestBodies.length).toBeGreaterThanOrEqual(2);
    expect(requestBodies.length).toBeLessThanOrEqual(4);
    for (const body of requestBodies.slice(1)) {
      expect(body.timeoutSeconds).toBeLessThanOrEqual(1);
    }
  });

  it("propagates a non-timeout fetch failure instead of retrying forever", async () => {
    const { fetchImpl } = createWatchScriptFetch([
      { events: [], timedOut: true, nextSequence: 1 },
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    ]);

    await expect(
      callTool(
        "roughdraft_watch_review_events",
        { documentPath, projectPath: projectDir },
        { ROUGHDRAFT_STATE_FILE: stateFile },
        fetchImpl,
      ),
    ).rejects.toThrow("fetch failed");
  });

  // A mocked fetch cannot prove the sequence cursor the segments hand each
  // other, because the mock does not implement it. This drives the tool over a
  // real socket against the real watch endpoint, with segments short enough
  // that the Done Reviewing event lands in a later one.
  it("delivers a review event that arrives after the first segment, against a real server", async () => {
    const { app } = createApp({ homeDir: tempDir, staticDirPath: projectDir });
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const { port } = server.address() as AddressInfo;
    const serverUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(stateFile, JSON.stringify({ url: serverUrl, port }));

    try {
      const watched = callTool(
        "roughdraft_watch_review_events",
        { documentPath, projectPath: projectDir },
        {
          ROUGHDRAFT_STATE_FILE: stateFile,
          ROUGHDRAFT_WATCH_SEGMENT_SECONDS: "1",
        },
        fetch,
      );

      await delay(1600);
      const emitted = await fetch(`${serverUrl}/api/review-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath: projectDir, path: "draft.md" }),
      });
      expect(emitted.status).toBe(201);

      const result = (await watched) as {
        timedOut?: boolean;
        events?: Array<{ documentPath?: string }>;
      };

      expect(result.timedOut).toBe(false);
      expect(result.events).toHaveLength(1);
      expect(result.events?.[0]).toMatchObject({ documentPath });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);

  it("returns overall comments from review watch events unchanged", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          events: [
            {
              documentPath,
              type: "review.completed",
              overallComment: "Please prioritize the CLI contract.",
            },
          ],
          timedOut: false,
          nextSequence: 2,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );

    const result = await callTool(
      "roughdraft_watch_review_events",
      { documentPath, projectPath: projectDir },
      { ROUGHDRAFT_STATE_FILE: stateFile },
      fetchImpl,
    );

    expect(result).toMatchObject({
      events: [
        {
          overallComment: "Please prioritize the CLI contract.",
        },
      ],
    });
  });

  it("does not write a reply when the message contains a CriticMarkup close delimiter", async () => {
    const original =
      '# Draft\n\n{>>Needs proof<<}{id="c1" by="user" at="2026-04-28T12:00:00.000Z"}\n';
    fs.writeFileSync(documentPath, original);

    await expect(
      callTool(
        "roughdraft_reply_to_comment",
        {
          documentPath,
          parentId: "c1",
          message: "This closes early <<} and breaks parsing.",
        },
        { ROUGHDRAFT_STATE_FILE: stateFile },
      ),
    ).rejects.toThrow(/CriticMarkup close delimiter/);

    expect(fs.readFileSync(documentPath, "utf8")).toBe(original);
  });
});
