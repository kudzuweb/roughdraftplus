// One long-poll against /api/review-events/watch cannot outlive five minutes:
// the server caps a single wait at 300s and undici's default headersTimeout is
// also 300s, so client and server race to a dead heat and the Done Reviewing
// signal is lost. Every watcher — the CLI's `watch`/`open` and the MCP
// `roughdraft_watch_review_events` tool — polls through this module instead, in
// segments that end well under both limits and carry the sequence cursor across
// the gap so no event slips through it.

import { tokenAuthHeaders } from "./network.js";

const DEFAULT_SEGMENT_CAP_SECONDS = 240;
const ABORT_MARGIN_SECONDS = 15;

export interface ReviewWatchPayload<TEvent = unknown> {
  events?: TEvent[];
  timedOut?: boolean;
  nextSequence?: number;
  instanceId?: string;
}

// What a caller's error handler wants the loop to do next: carry on from the
// same cursor, prime again because the queue it was reading is gone, stop and
// report the payload it already has, or give up on the watch entirely.
export type WatchErrorAction = "resume" | "reprime" | "stop" | "abandon";

export interface SegmentedWatchOptions<TEvent = unknown> {
  fetchImpl: typeof fetch;
  env: NodeJS.ProcessEnv;
  serverUrl: string;
  projectPath: string;
  relativePath: string;
  batchWindowSeconds: number;
  fromNow: boolean;
  // The instant the watch gives up, as epoch milliseconds. The caller owns it
  // so anything else it bounds by the same deadline agrees to the millisecond.
  // Omitted, the watch polls until the review completes.
  deadlineMs?: number;
  // Called with each priming poll's payload, which is where the server reports
  // the instance a caller may want to recognise later.
  onPrimed?: (payload: ReviewWatchPayload<TEvent>) => void;
  // Called for any poll failure that is not a segment timeout. Without it such
  // a failure propagates, which is what an unattended watcher wants.
  onPollError?: (
    error: unknown,
  ) => WatchErrorAction | Promise<WatchErrorAction>;
}

export interface SegmentedWatchResult<TEvent = unknown> {
  payload: ReviewWatchPayload<TEvent>;
  abandoned: boolean;
}

function resolveWatchSegmentSeconds(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.ROUGHDRAFT_WATCH_SEGMENT_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SEGMENT_CAP_SECONDS;
}

export function watchErrorCode(error: unknown): string | undefined {
  const withCode = error as {
    cause?: { code?: string };
    code?: string;
  } | null;
  return withCode?.cause?.code ?? withCode?.code;
}

function isSegmentTimeout(error: unknown): boolean {
  const code = watchErrorCode(error);
  const name = (error as { name?: string } | null)?.name;
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    name === "TimeoutError" ||
    name === "AbortError"
  );
}

export async function watchReviewEventsInSegments<TEvent = unknown>(
  options: SegmentedWatchOptions<TEvent>,
): Promise<SegmentedWatchResult<TEvent>> {
  const segmentCapSeconds = resolveWatchSegmentSeconds(options.env);

  const postWatch = async (
    extra: { fromNow: boolean; afterSequence?: number },
    segmentSeconds: number,
  ): Promise<ReviewWatchPayload<TEvent>> => {
    const response = await options.fetchImpl(
      new URL("/api/review-events/watch", options.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...tokenAuthHeaders(options.env),
        },
        body: JSON.stringify({
          projectPath: options.projectPath,
          path: options.relativePath,
          batchWindowSeconds: options.batchWindowSeconds,
          timeoutSeconds: segmentSeconds,
          ...extra,
        }),
        signal: AbortSignal.timeout(
          (segmentSeconds + ABORT_MARGIN_SECONDS) * 1000,
        ),
      },
    );
    if (response.status === 401) {
      throw new Error(
        "The Roughdraft server rejected the review watch (HTTP 401). It is bound to a non-loopback address, so set ROUGHDRAFT_TOKEN to the token the server was started with before retrying.",
      );
    }
    if (!response.ok) {
      throw new Error(`Failed to watch review events: ${response.status}`);
    }
    return (await response.json()) as ReviewWatchPayload<TEvent>;
  };

  const prime = async (): Promise<ReviewWatchPayload<TEvent>> => {
    const primed = await postWatch({ fromNow: options.fromNow }, 0);
    options.onPrimed?.(primed);
    return primed;
  };

  // The priming poll returns immediately and yields the sequence cursor, so a
  // segment that dies before delivering one cannot lose an event.
  let payload = await prime();
  let afterSequence =
    typeof payload.nextSequence === "number" ? payload.nextSequence - 1 : 0;
  let primeAgain = false;

  while (payload.timedOut) {
    let segmentSeconds = segmentCapSeconds;
    if (options.deadlineMs !== undefined) {
      const remaining = Math.ceil((options.deadlineMs - Date.now()) / 1000);
      if (remaining <= 0) break;
      segmentSeconds = Math.min(segmentSeconds, remaining);
    }
    try {
      if (primeAgain) {
        payload = await prime();
        primeAgain = false;
      } else {
        payload = await postWatch(
          { fromNow: false, afterSequence },
          segmentSeconds,
        );
      }
    } catch (error) {
      if (isSegmentTimeout(error)) continue;
      if (!options.onPollError) throw error;
      const action = await options.onPollError(error);
      if (action === "abandon") return { payload, abandoned: true };
      if (action === "stop") break;
      if (action === "reprime") primeAgain = true;
      continue;
    }
    if (typeof payload.nextSequence === "number") {
      afterSequence = payload.nextSequence - 1;
    }
  }

  return { payload, abandoned: false };
}
