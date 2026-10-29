import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { IDatabaseHandle } from "../sql/ISQLService";
import type { Result } from "../types";
import type { SqlValue } from "../sql/types";
import {
  appendFeedResponse,
  getFeedCardState,
  initializeFeedDatabases,
  listFeedResponses,
  publishFeedCard,
  recordFeedHandling,
  resolveFeedCard,
} from "./index";
import type { FeedCard, FeedDatabase, NewFeedResponse } from "./types";

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

// Real SQLite with the existing SQL handle's positional row and Result contract.
function sqlite(): FeedDatabase {
  const database = new Database(":memory:");
  databases.push(database);
  const execute: IDatabaseHandle["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return {
      ok: true,
      data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) },
    };
  };
  return {
    query: async <T>(sql: string, params: SqlValue[] = []) => {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    batch: async (statements) => {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(value(await execute(statement.sql, statement.params)));
        }
        database.exec("COMMIT");
        return { ok: true, data: { results } };
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

const card: FeedCard = {
  cardId: "card-0123456789-owner-decision",
  revision: 1,
  issuanceId: "issuance-0123456789-first",
  kind: "decision",
  needsResponse: true,
  title: "Create the reversible draft?",
  body: "Create a draft only, without sending it.",
  choices: [{ id: "draft", label: "Create draft" }],
  urgency: 1,
  createdAt: "2026-10-28T12:00:00.000Z",
};
const response: NewFeedResponse = {
  cardId: card.cardId,
  revision: card.revision,
  issuanceId: card.issuanceId,
  responseId: "response-0123456789-owner-answer",
  kind: "answer",
  choiceId: "draft",
  createdAt: "2026-10-28T12:01:00.000Z",
};

async function feed() {
  const output = sqlite();
  const responses = sqlite();
  value(await initializeFeedDatabases({ output, responses }));
  value(await publishFeedCard(output, card));
  return { output, responses };
}

describe("feed response identity", () => {
  test("saving the same full response identity twice produces one durable response", async () => {
    const { output, responses } = await feed();
    const first = value(await appendFeedResponse(output, responses, response));
    const repeated = value(await appendFeedResponse(output, responses, response));
    expect(repeated).toEqual(first);
    expect(value(await listFeedResponses(responses))).toEqual([first]);

    const conflicting = await appendFeedResponse(output, responses, {
      ...response,
      text: "This changes the meaning under the same ID",
    });
    expect(conflicting.ok).toBe(false);
    expect(value(await listFeedResponses(responses))).toEqual([first]);
  });

  test("responses and receipts from an earlier revision do not answer its successor", async () => {
    const { output, responses } = await feed();
    const saved = value(await appendFeedResponse(output, responses, response));
    value(await recordFeedHandling(output, {
      ...response,
      handlingId: "handling-old-revision-success",
      phase: "succeeded",
      detail: { draftId: "draft-first-revision" },
    }));
    const revised = { ...card, revision: 2, issuanceId: "issuance-second-question" };
    value(await publishFeedCard(output, revised));
    expect(value(await getFeedCardState(output, responses, revised))).toEqual({
      card: revised, response: null, acknowledgement: null, outcome: null,
    });
    expect(value(await getFeedCardState(output, responses, card)).response).toEqual(saved);
  });

  test("a new issuance of the same revision cannot inherit an old answer", async () => {
    const { output, responses } = await feed();
    value(await appendFeedResponse(output, responses, response));
    const reissued = { ...card, issuanceId: "issuance-reasked-same-revision" };
    value(await publishFeedCard(output, reissued));
    expect(value(await getFeedCardState(output, responses, reissued)).response).toBeNull();

    const unknownIssuance = await appendFeedResponse(output, responses, {
      ...response,
      responseId: "response-to-unissued-question",
      issuanceId: "issuance-never-published",
    });
    expect(unknownIssuance.ok).toBe(false);
    expect(value(await listFeedResponses(responses)).map((item) => item.responseId))
      .toEqual([response.responseId]);
  });

  test("short aliases never choose between colliding full card IDs", async () => {
    const { output } = await feed();
    const other = { ...card, cardId: "card-0123456789-another-decision" };
    value(await publishFeedCard(output, other));
    expect((await resolveFeedCard(output, "card-0123456789")).ok).toBe(false);
    expect(value(await resolveFeedCard(output, card.cardId))).toEqual({
      cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    });
  });
});

describe("saved response versus agent handling", () => {
  test("a persisted response is saved, not acknowledged or completed", async () => {
    const { output, responses } = await feed();
    const saved = value(await appendFeedResponse(output, responses, response));
    expect(value(await getFeedCardState(output, responses, card))).toEqual({
      card, response: saved, acknowledgement: null, outcome: null,
    });
  });

  test("acknowledgement and outcome preserve response identity and cannot erase each other", async () => {
    const { output, responses } = await feed();
    const saved = value(await appendFeedResponse(output, responses, response));
    const acknowledgement = {
      ...response, handlingId: "handling-acknowledged", phase: "acknowledged" as const,
    };
    const outcome = {
      ...response, handlingId: "handling-succeeded", phase: "succeeded" as const,
      detail: { draftId: "draft-durable-result" },
    };
    value(await recordFeedHandling(output, acknowledgement));
    expect(value(await getFeedCardState(output, responses, card))).toMatchObject({
      response: saved, acknowledgement: { phase: "acknowledged" }, outcome: null,
    });
    value(await recordFeedHandling(output, outcome));
    value(await recordFeedHandling(output, acknowledgement));
    const state = value(await getFeedCardState(output, responses, card));
    expect(state.acknowledgement?.handlingId).toBe(acknowledgement.handlingId);
    expect(state.outcome).toMatchObject({
      handlingId: outcome.handlingId, responseId: saved.responseId,
      phase: "succeeded", detail: { draftId: "draft-durable-result" },
    });
    expect(value(await listFeedResponses(responses))).toEqual([saved]);
  });
});
