import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { callCostMicros } from "../cost";
import { createChatHandler } from "../chat-handler";
import { createAssistantModel } from "../model";
import { storeScoped } from "../../db";
import { usdMentions } from "./money";
import { adjustTicketSpend, tryReserveTicket } from "./report";
import { bindingFromFixture, scoreCase, type CatalogBinding, type ObservedTool, type TextBlock } from "./score";
import {
  createEvalStores,
  deleteOwnedStores,
  sweepAbandonedEvalStores,
  writeLease,
  type CreatedEvalStores,
} from "./fixture-store";
import { recordingFetch, type RecordedExchange } from "./recording-fetch";
import { validateDataset, validateFixture } from "./dataset";
import type { CartSnapshotLine, CaseResult, CatalogFixture, EvalCase, HallucinatedItem, RunResult } from "./types";

const attemptStore = new AsyncLocalStorage<string>();
const RESERVE_MICROS = BigInt(150000);
const WRITE_TOOLS = new Set(["add_to_cart", "update_cart", "remove_from_cart", "set_swap_rule"]);

export interface AttemptContext {
  caseId: string;
  attempt: number;
  binding: CatalogBinding;
  stores: CreatedEvalStores;
}

export interface RunEvalOptions {
  cases: EvalCase[];
  fixture: CatalogFixture;
  now: Date;
  concurrency: number;
  maxMicros: bigint;
  priorTicketMicros: bigint;
  ticketCapMicros: bigint;
  full: boolean;
  fetchForAttempt: (ctx: AttemptContext) => typeof fetch | Promise<typeof fetch>;
  settleTimeoutMs?: number;
  stripTimeoutMs?: number;
  retryDelayMs?: (attempt: number, retryAfterSeconds: number | null) => number;
  maxAttempts?: number;
  whileWaitingForStrips?: () => void;
  cleanup?: (stores: CreatedEvalStores) => Promise<void>;
  ticketSpendPath?: string;
}

export interface EvalRun {
  result: RunResult;
  binding: CatalogBinding | null;
  stores: CreatedEvalStores | null;
  firstRequestBody: Record<string, unknown> | null;
  masterCatalog: CreatedEvalStores["masterCatalog"];
}

export async function runEval(options: RunEvalOptions): Promise<EvalRun> {
  const fixture = validateFixture(options.fixture);
  const cases = validateDataset(options.cases, fixture, { full: options.full, allowOverlap: !options.full });
  options = { ...options, cases, fixture };
  const previousEnabled = process.env.ASSISTANT_CHAT_ENABLED;
  process.env.ASSISTANT_CHAT_ENABLED = "1";
  const logs = installAssistantLogWatch();
  let stores: CreatedEvalStores | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const result = emptyResult();
  let firstRequestBody: Record<string, unknown> | null = null;
  let aborted: { reason: string } | null = null;
  const budget = createBudget(options);
  try {
    await sweepAbandonedEvalStores("pending");
    stores = await createEvalStores(options.fixture);
    const created = stores;
    heartbeat = setInterval(() => writeLease(created.runId, [created.slugA, created.slugB]), 20_000);
    heartbeat.unref?.();
    result.sessionUser = "app_runtime";
    const binding = bindingFromFixture(options.fixture, created.ids);
    const ledgerBefore = await readLedger();
    const stripWatches: StripWatch[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(options.concurrency, options.cases.length) }, async () => {
      while (!aborted) {
        const index = cursor;
        cursor += 1;
        const evalCase = options.cases[index];
        if (!evalCase) return;
        const holds = { open: 0 };
        const admitted = await budget.admit(holds);
        if (!admitted) {
          aborted = { reason: budget.ticketBlocked ? "ticket budget" : "budget" };
          return;
        }
        let caseMicros = BigInt(0);
        let threw = false;
        try {
          const outcome = await attemptStore.run(`case:${evalCase.id}`, () => runCase(evalCase, index, created, binding, options, budget, holds, () => aborted, (body) => {
            if (!firstRequestBody && body) firstRequestBody = body;
          }, stripWatches));
          caseMicros = outcome.costMicros;
          if (outcome.abort) aborted = { reason: outcome.abort };
          if (outcome.unresolved) result.unresolvedSpend = true;
          result.inputTokens += outcome.inputTokens;
          result.outputTokens += outcome.outputTokens;
          result.cases.push(outcome.caseResult);
        } catch (error) {
          threw = true;
          aborted = { reason: error instanceof Error ? error.message : "worker failed" };
          result.unresolvedSpend = true;
        } finally {
          if (holds.open > 0) await budget.finishAttempt(holds, threw ? 1 : 0, BigInt(0));
          result.spendMicros += caseMicros;
        }
      }
    });
    await Promise.allSettled(workers);
    if (await drainStrips(stripWatches, result, options.stripTimeoutMs ?? 10_000)) {
      aborted = aborted ?? { reason: "strip evidence" };
      result.unresolvedSpend = true;
    }
    if (logs.unattributed.length > 0) aborted = { reason: "unattributed integrity" };
    const ledgerAfter = await readLedger();
    result.ledgerDeltaMicros = ledgerAfter - ledgerBefore;
    const conversations = await storeScoped(created.storeAId).aiConversation.findMany({ select: { costMicros: true } });
    result.conversationMicros = conversations.reduce((sum, row) => sum + row.costMicros, BigInt(0));
    const ranAll = result.cases.length === options.cases.length;
    const order = new Map(options.cases.map((item, index) => [item.id, index]));
    result.cases.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    result.complete = !aborted && ranAll && !result.unresolvedSpend;
    result.incompleteReason = aborted?.reason ?? (result.unresolvedSpend ? "unresolved usage" : ranAll ? null : "budget");
    if (result.incompleteReason === "budget" || result.incompleteReason === "ticket budget") {
      result.complete = false;
    }
    const totalsDisagree = result.ledgerDeltaMicros !== result.spendMicros || result.conversationMicros !== result.spendMicros;
    if (totalsDisagree) {
      result.unresolvedSpend = true;
      result.complete = false;
      result.incompleteReason = result.incompleteReason ?? "spend mismatch";
    }
    return { result, binding, stores: created, firstRequestBody, masterCatalog: created.masterCatalog };
  } catch (error) {
    result.complete = false;
    result.incompleteReason = error instanceof Error ? error.message : "eval failed";
    return { result, binding: null, stores, firstRequestBody, masterCatalog: stores?.masterCatalog ?? [] };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (stores) {
      try {
        await (options.cleanup ?? deleteOwnedStores)(stores);
      } catch (error) {
        result.cleanupError = error instanceof Error ? error.message : "cleanup failed";
        result.complete = false;
        result.incompleteReason = result.incompleteReason ?? "cleanup failed";
      }
    }
    logs.restore();
    if (previousEnabled === undefined) delete process.env.ASSISTANT_CHAT_ENABLED;
    else process.env.ASSISTANT_CHAT_ENABLED = previousEnabled;
  }
}

interface CaseOutcome {
  caseResult: CaseResult;
  costMicros: bigint;
  abort: string | null;
  unresolved: boolean;
  inputTokens: number;
  outputTokens: number;
}

async function runCase(
  evalCase: EvalCase,
  index: number,
  stores: CreatedEvalStores,
  binding: CatalogBinding,
  options: RunEvalOptions,
  budget: Budget,
  holds: ReserveHolds,
  aborted: () => { reason: string } | null,
  onRequest: (body: Record<string, unknown> | null) => void,
  stripWatches: StripWatch[],
): Promise<CaseOutcome> {
  const maxAttempts = options.maxAttempts ?? 3;
  let attempts = 0;
  let sticky = false;
  let cost = BigInt(0);
  let inputTokens = 0;
  let outputTokens = 0;
  let unresolved = false;
  let last: CaseResult | null = null;
  const provenance: CaseResult["requestProvenance"] = [];
  const carried = emptyCarry();
  while (attempts < maxAttempts) {
    if (aborted()) break;
    if (attempts > 0) {
      const again = await budget.admitRetry(holds);
      if (!again) return finish(last ? applyCarry(remember(last, provenance), carried) : null, evalCase, attempts, cost, "budget", true, inputTokens, outputTokens, unresolved);
    }
    attempts += 1;
    const attemptKey = `${evalCase.id}:${attempts}`;
    const outcome = await attemptStore.run(attemptKey, () => oneAttempt(evalCase, index, attempts, stores, binding, options, onRequest, stripWatches));
    cost += outcome.costMicros;
    inputTokens += outcome.inputTokens;
    outputTokens += outcome.outputTokens;
    await budget.finishAttempt(holds, outcome.unknownSends, outcome.costMicros);
    if (outcome.sticky) sticky = true;
    unresolved = unresolved || outcome.unresolved;
    provenance.push(...outcome.caseResult.requestProvenance);
    if (outcome.abort) {
      return finish(applyCarry(remember(outcome.caseResult, provenance), carried), evalCase, attempts, cost, outcome.abort, sticky, inputTokens, outputTokens, unresolved);
    }
    if (!outcome.retry) {
      const saved = applyCarry(remember(outcome.caseResult, provenance), carried);
      saved.attempts = attempts;
      saved.stickyIntegrity = sticky || saved.stickyIntegrity;
      if (saved.stickyIntegrity) {
        saved.pass = false;
        saved.reason = saved.reason === "ok" ? "earlier integrity failure" : saved.reason;
      }
      saved.costMicros = cost.toString();
      return { caseResult: saved, costMicros: cost, abort: null, unresolved, inputTokens, outputTokens };
    }
    absorbCarry(carried, outcome.caseResult);
    if (outcome.sticky || outcome.caseResult.hallucinated.length > 0 || outcome.caseResult.safetyFailures.length > 0 || outcome.caseResult.ungroundedAmountsShown.length > 0) sticky = true;
    last = remember(outcome.caseResult, provenance);
    const delay = options.retryDelayMs ?? defaultRetryDelay;
    await sleep(delay(attempts, outcome.retryAfterSeconds));
  }
  return finish(last ? applyCarry(remember(last, provenance), carried) : null, evalCase, attempts, cost, null, sticky, inputTokens, outputTokens, unresolved);
}

function emptyCarry(): Pick<CaseResult, "hallucinated" | "safetyFailures" | "ungroundedAmountsShown" | "temporalViolations"> {
  return { hallucinated: [], safetyFailures: [], ungroundedAmountsShown: [], temporalViolations: [] };
}

function sameHallucination(left: HallucinatedItem, right: HallucinatedItem): boolean {
  return left.field === right.field && left.id === right.id && left.crossStore === right.crossStore;
}

function absorbCarry(carried: ReturnType<typeof emptyCarry>, item: CaseResult): void {
  for (const found of item.hallucinated) {
    if (!carried.hallucinated.some((have) => sameHallucination(have, found))) carried.hallucinated.push(found);
  }
  for (const failure of item.safetyFailures) {
    if (!carried.safetyFailures.includes(failure)) carried.safetyFailures.push(failure);
  }
  for (const amount of item.ungroundedAmountsShown) {
    if (!carried.ungroundedAmountsShown.includes(amount)) carried.ungroundedAmountsShown.push(amount);
  }
  for (const amount of item.temporalViolations) {
    if (!carried.temporalViolations.includes(amount)) carried.temporalViolations.push(amount);
  }
}

function applyCarry(item: CaseResult, carried: ReturnType<typeof emptyCarry>): CaseResult {
  for (const found of carried.hallucinated) {
    if (!item.hallucinated.some((have) => sameHallucination(have, found))) item.hallucinated.push(found);
  }
  item.safetyFailures = [...new Set([...item.safetyFailures, ...carried.safetyFailures])];
  for (const amount of carried.ungroundedAmountsShown) {
    if (!item.ungroundedAmountsShown.includes(amount)) item.ungroundedAmountsShown.push(amount);
  }
  for (const amount of carried.temporalViolations) {
    if (!item.temporalViolations.includes(amount)) item.temporalViolations.push(amount);
  }
  if (carried.hallucinated.length > 0 || carried.safetyFailures.length > 0 || carried.ungroundedAmountsShown.length > 0) {
    item.stickyIntegrity = true;
    item.pass = false;
    if (item.reason === "ok") item.reason = "earlier integrity failure";
  }
  return item;
}

function remember(result: CaseResult, provenance: CaseResult["requestProvenance"]): CaseResult {
  result.requestProvenance = provenance;
  result.anthropicRequestIds = provenance.map((step) => step.requestId);
  return result;
}

function finish(
  last: CaseResult | null,
  evalCase: EvalCase,
  attempts: number,
  cost: bigint,
  abort: string | null,
  sticky: boolean,
  inputTokens: number,
  outputTokens: number,
  unresolved: boolean,
): CaseOutcome {
  const caseResult = last ?? blankCase(evalCase);
  caseResult.attempts = attempts;
  caseResult.costMicros = cost.toString();
  caseResult.stickyIntegrity = sticky || caseResult.stickyIntegrity;
  caseResult.pass = false;
  if (abort) caseResult.reason = abort;
  return { caseResult, costMicros: cost, abort, unresolved, inputTokens, outputTokens };
}

async function oneAttempt(
  evalCase: EvalCase,
  index: number,
  attempt: number,
  stores: CreatedEvalStores,
  binding: CatalogBinding,
  options: RunEvalOptions,
  onRequest: (body: Record<string, unknown> | null) => void,
  stripWatches: StripWatch[],
): Promise<{
  caseResult: CaseResult;
  costMicros: bigint;
  abort: string | null;
  retry: boolean;
  retryAfterSeconds: number | null;
  unresolved: boolean;
  unknownSends: number;
  sticky: boolean;
  inputTokens: number;
  outputTokens: number;
}> {
  const exchanges: RecordedExchange[] = [];
  let cartId = "";
  let retry = false;
  let abort: string | null = null;
  let retryAfterSeconds: number | null = null;
  let steps = 0;
  const provenance: CaseResult["requestProvenance"] = [];
  const observed: TextBlock[] = [];
  try {
  const inner = await options.fetchForAttempt({ caseId: evalCase.id, attempt, binding, stores });
  const fetchImpl = recordingFetch(inner, exchanges);
  const handler = createChatHandler({
    model: createAssistantModel({ fetch: fetchImpl }),
    now: () => options.now,
  });
  const ip = `2001:db8:${stores.runId.slice(0, 4)}:${index}:${attempt}`;
  let cookie: string | null = null;
  for (let turn = 0; turn < evalCase.turns.length; turn += 1) {
    const started = exchanges.length;
    const messageId = `e${randomBytes(8).toString("hex")}`;
    const response = await handler(requestFor(stores.slugA, evalCase.turns[turn] ?? "", messageId, ip, cookie));
    const bodyText = await response.text();
    await Promise.all(exchanges.slice(started).map((exchange) => exchange.done));
    const turnExchanges = exchanges.slice(started);
    steps += turnExchanges.length;
    if (!cookie) {
      cookie = readCartCookie(response);
      cartId = cookie ?? "";
    }
    const handlerFailure = classifyHandler(response.status, bodyText);
    if (handlerFailure.abort) {
      abort = handlerFailure.abort;
      break;
    }
    if (handlerFailure.loud) {
      abort = handlerFailure.loud;
      break;
    }
    for (const [step, exchange] of turnExchanges.entries()) {
      if (exchange.requestBody) onRequest(exchange.requestBody);
      if (exchange.requestId) {
        provenance.push({ attempt, turn: turn + 1, step: step + 1, requestId: exchange.requestId });
      }
      const decision = classifyProvider(exchange);
      if (decision.kind === "abort") abort = decision.reason;
      if (decision.kind === "retry") {
        retry = true;
        retryAfterSeconds = decision.retryAfterSeconds;
      }
    }
    if (abort || retry) break;
    const settled = await waitSettled(stores.storeAId, cartId, messageId, options.settleTimeoutMs ?? 75_000);
    if (!settled) {
      retry = true;
      break;
    }
    if (settled.status === "failed") {
      retry = true;
      break;
    }
    const logs = attemptLogs(attemptStore.getStore() ?? "");
    if (logs.some((line) => /not saved|not recorded/.test(line))) {
      retry = true;
      break;
    }
    const expectStrip = amountsMissingFromSaved(turnExchanges, settled.messages);
    const strips = await waitStrips(stores.storeAId, settled.conversationId, options.stripTimeoutMs ?? 10_000, turn === evalCase.turns.length - 1 ? options.whileWaitingForStrips : undefined, expectStrip);
    if (strips && (expectStrip || strips.length > 0)) {
      stripWatches.push({ storeId: stores.storeAId, conversationId: settled.conversationId, caseId: evalCase.id });
    }
    if (!strips) {
      retry = true;
      break;
    }
    if (turn === evalCase.turns.length - 1) {
      const scored = await scoreAttempt({
        evalCase,
        binding,
        messages: settled.messages,
        strips,
        exchanges,
        cartId,
        storeId: stores.storeAId,
        steps,
        provenance,
        observed,
      });
      const money = spendOf(exchanges);
      const caseResult = scored.caseResult;
      caseResult.steps = steps;
      caseResult.anthropicRequestIds = provenance.map((item) => item.requestId);
      caseResult.requestProvenance = provenance;
      return {
        caseResult,
        costMicros: money.micros,
        abort,
        retry,
        retryAfterSeconds,
        unresolved: money.unresolved,
        unknownSends: money.unknownSends,
        sticky: scored.sticky,
        inputTokens: money.inputTokens,
        outputTokens: money.outputTokens,
      };
    }
  }
  const money = spendOf(exchanges);
  const blank = blankCase(evalCase);
  blank.steps = steps;
  blank.reason = abort ?? "retry";
  blank.anthropicRequestIds = provenance.map((item) => item.requestId);
  blank.requestProvenance = provenance;
  await fillAbandonedIntegrity(blank, { evalCase, binding, exchanges, cartId, storeId: stores.storeAId, steps, provenance, observed });
  const logged = attemptLogs(attemptStore.getStore() ?? "").some((line) => /not saved|not recorded/.test(line));
  return {
    caseResult: blank,
    costMicros: money.micros,
    abort,
    retry: abort ? false : true,
    retryAfterSeconds,
    unresolved: money.unresolved,
    unknownSends: money.unknownSends,
    sticky: logged || blank.stickyIntegrity,
    inputTokens: money.inputTokens,
    outputTokens: money.outputTokens,
  };
  } catch (error) {
    const money = spendOf(exchanges);
    const blank = blankCase(evalCase);
    blank.reason = error instanceof Error ? error.message : "attempt failed";
    await fillAbandonedIntegrity(blank, { evalCase, binding, exchanges, cartId, storeId: stores.storeAId, steps, provenance, observed });
    return {
      caseResult: blank,
      costMicros: money.micros,
      abort: null,
      retry: true,
      retryAfterSeconds: null,
      unresolved: true,
      unknownSends: Math.max(money.unknownSends, 1),
      sticky: blank.stickyIntegrity,
      inputTokens: money.inputTokens,
      outputTokens: money.outputTokens,
    };
  }
}

async function fillAbandonedIntegrity(blank: CaseResult, args: {
  evalCase: EvalCase;
  binding: CatalogBinding;
  exchanges: RecordedExchange[];
  cartId: string;
  storeId: string;
  steps: number;
  provenance: CaseResult["requestProvenance"];
  observed: TextBlock[];
}): Promise<void> {
  if (!args.cartId) return;
  try {
    const row = await storeScoped(args.storeId).aiConversation.findFirst({ where: { storeId: args.storeId, cartId: args.cartId } });
    const messages = Array.isArray(row?.messages) ? row.messages as Array<Record<string, unknown>> : [];
    if (!row) return;
    const scored = await scoreAttempt({ ...args, messages, strips: [] });
    blank.hallucinated = scored.caseResult.hallucinated;
    blank.safetyFailures = scored.caseResult.safetyFailures;
    blank.ungroundedAmountsShown = scored.caseResult.ungroundedAmountsShown;
    blank.temporalViolations = scored.caseResult.temporalViolations;
    blank.finalCart = scored.caseResult.finalCart;
    blank.stickyIntegrity = scored.caseResult.hallucinated.length > 0
      || scored.caseResult.safetyFailures.length > 0
      || scored.caseResult.ungroundedAmountsShown.length > 0
      || scored.sticky;
  } catch {
    // A transport failure can leave no settled conversation. Request ids still travel with the blank case.
  }
}

async function scoreAttempt(args: {
  evalCase: EvalCase;
  binding: CatalogBinding;
  messages: Array<Record<string, unknown>>;
  strips: string[];
  exchanges: RecordedExchange[];
  cartId: string;
  storeId: string;
  steps: number;
  provenance: CaseResult["requestProvenance"];
  observed: TextBlock[];
}): Promise<{ caseResult: CaseResult; sticky: boolean }> {
  const conversation = await storeScoped(args.storeId).aiConversation.findFirst({
    where: { storeId: args.storeId, cartId: args.cartId },
  });
  if (!conversation) throw new Error("Eval evidence is missing the conversation.");
  const lines = await storeScoped(args.storeId).cartLine.findMany({
    where: { cartId: args.cartId },
    include: { variant: true },
  });
  const cart: CartSnapshotLine[] = lines.map((line) => {
    const bound = args.binding.byVariantId.get(line.variantId);
    const substitute = line.substituteVariantId ? args.binding.byVariantId.get(line.substituteVariantId) : undefined;
    return {
      key: bound?.listingKey ?? line.variantId,
      variantKey: bound?.key ?? line.variantId,
      qty: line.qty,
      swapRule: line.swapRule,
      substituteVariantKey: substitute?.key ?? null,
    };
  });
  const quantityChecks = args.evalCase.qty?.length ?? 0;
  const quantityHits = (args.evalCase.qty ?? []).filter((rule) => cart.some((line) => line.key === rule.listingKey && line.variantKey === rule.variantKey && line.qty >= rule.min && line.qty <= rule.max)).length;
  const tools = toolsFromMessages(args.messages);
  mergeStreamTools(tools, args.exchanges);
  const toolInputErrors = tools.filter((tool) => failedToolInput(tool.output)).length;
  const savedTexts = textsFromMessages(args.messages);
  const observedTexts = textsFromExchanges(args.exchanges, tools);
  const replies = [...savedTexts.map((block) => block.text), ...args.messages.flatMap(assistantText)];
  const scored = scoreCase({
    evalCase: args.evalCase,
    cart,
    tools,
    savedTexts,
    observedTexts,
    strippedAmounts: args.strips,
    successfulWriteTurns: tools.filter((tool) => WRITE_TOOLS.has(tool.tool) && outputOk(tool.output)).map((tool) => tool.turn),
    returnedLineIds: lineIdsFrom(tools.map((tool) => tool.output)),
    cartLineIds: lines.map((line) => line.id),
    stepLimitHit: args.messages.some((message) => JSON.stringify(message).includes("I've done as much as I can in one go")),
  }, args.binding, replies);
  const caseResult: CaseResult = {
    id: args.evalCase.id,
    category: args.evalCase.category,
    pass: scored.pass,
    reason: scored.reason,
    attempts: 1,
    precision: scored.precision,
    recall: scored.recall,
    precisionNumerator: scored.precisionNumerator,
    precisionDenominator: scored.precisionDenominator,
    recallNumerator: scored.recallNumerator,
    recallDenominator: scored.recallDenominator,
    hallucinated: scored.hallucinated,
    strippedAmounts: args.strips,
    ungroundedAmountsShown: scored.ungroundedAmountsShown,
    temporalViolations: scored.temporalViolations,
    gapsReported: scored.gapsReported,
    safetyFailures: scored.safetyFailures,
    stickyIntegrity: scored.safetyFailures.includes("audit_failed"),
    finalCart: cart,
    steps: args.steps,
    stepLimitHit: args.messages.some((message) => JSON.stringify(message).includes("I've done as much as I can in one go")),
    toolInputErrors,
    quantityChecks,
    quantityHits,
    gapRequired: args.evalCase.gaps.length > 0,
    costMicros: "0",
    anthropicRequestIds: [],
    requestProvenance: args.provenance,
  };
  return { caseResult, sticky: caseResult.stickyIntegrity };
}

function toolsFromMessages(messages: Array<Record<string, unknown>>): ObservedTool[] {
  const tools: ObservedTool[] = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      continue;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: string; toolName?: string; input?: unknown; output?: unknown };
      const name = record.type?.startsWith("tool-") ? record.type.slice(5) : record.toolName;
      if (!name || name === "grounding_strip") continue;
      tools.push({ tool: name, input: record.input, output: record.output, turn });
    }
  }
  return tools;
}

function mergeStreamTools(tools: ObservedTool[], exchanges: RecordedExchange[]): void {
  let turn = 1;
  for (const exchange of exchanges) {
    for (const use of exchange.toolUses) {
      const known = tools.some((tool) => tool.tool === use.name && JSON.stringify(tool.input) === JSON.stringify(use.input));
      if (!known) tools.push({ tool: use.name, input: use.input, output: null, turn });
    }
    if (exchange.text) turn += 0;
  }
}

function textsFromMessages(messages: Array<Record<string, unknown>>): TextBlock[] {
  const blocks: TextBlock[] = [];
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      continue;
    }
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const prior: unknown[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: string; text?: string; output?: unknown };
      if (record.type?.startsWith("tool-")) prior.push(record.output);
      if (record.type === "text" && typeof record.text === "string") {
        blocks.push({ turn, text: record.text, priorOutputs: [...prior], saved: true });
      }
    }
  }
  return blocks;
}

function textsFromExchanges(exchanges: RecordedExchange[], tools: ObservedTool[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  const outputs: unknown[] = [];
  let toolIndex = 0;
  let turn = 1;
  let seenText = false;
  for (const exchange of exchanges) {
    if (seenText && exchange.text) turn += 1;
    if (exchange.text) {
      blocks.push({ turn, text: exchange.text, priorOutputs: [...outputs], saved: false });
      seenText = true;
    }
    exchange.toolUses.forEach(() => {
      const output = tools[toolIndex]?.output;
      if (output !== undefined) outputs.push(output);
      toolIndex += 1;
    });
  }
  return blocks;
}

function assistantText(message: Record<string, unknown>): string[] {
  if (message.role !== "assistant" || !Array.isArray(message.parts)) return [];
  return message.parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
}

function lineIdsFrom(values: unknown[]): string[] {
  const ids: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "lineId" && typeof child === "string") ids.push(child);
      else walk(child);
    }
  };
  for (const value of values) walk(value);
  return ids;
}

function outputOk(output: unknown): boolean {
  return !!output && typeof output === "object" && (output as { ok?: unknown }).ok === true;
}

function classifyHandler(status: number, body: string): { abort?: string; loud?: string } {
  let code = "";
  try {
    code = (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? "";
  } catch {
    code = "";
  }
  if (status === 503 && code === "assistant_resting") return { abort: "spend cap" };
  if (status === 503 && code === "assistant_unavailable") return { abort: "config" };
  if (status === 409 || status === 429 || status === 400) return { loud: `handler ${status} ${code || "error"}` };
  if (status !== 200) return { loud: `handler ${status}` };
  return {};
}

function classifyProvider(exchange: RecordedExchange): { kind: "ok" | "retry" | "abort"; reason: string; retryAfterSeconds: number | null } {
  const retryAfterSeconds = exchange.retryAfter && /^\d+$/.test(exchange.retryAfter) ? Number(exchange.retryAfter) : null;
  if (exchange.status === 401) return { kind: "abort", reason: "authentication", retryAfterSeconds };
  if (exchange.status === 402) return { kind: "abort", reason: "billing", retryAfterSeconds };
  if (exchange.status === 403) return { kind: "abort", reason: "permission", retryAfterSeconds };
  if (exchange.status === 404) return { kind: "abort", reason: "not found", retryAfterSeconds };
  if (exchange.status === 400) return { kind: "abort", reason: "invalid request", retryAfterSeconds };
  if (exchange.status === 429) {
    return retryAfterSeconds == null
      ? { kind: "abort", reason: "tier spend cap", retryAfterSeconds }
      : { kind: "retry", reason: "rate limit", retryAfterSeconds };
  }
  if (exchange.status === 529 || exchange.status >= 500) return { kind: "retry", reason: "provider", retryAfterSeconds };
  if (exchange.sseError) return { kind: "retry", reason: "stream error", retryAfterSeconds };
  if (exchange.unresolvedUsage) return { kind: "retry", reason: "truncated stream", retryAfterSeconds };
  return { kind: "ok", reason: "", retryAfterSeconds };
}

function spendOf(exchanges: RecordedExchange[]): { micros: bigint; unresolved: boolean; unknownSends: number; inputTokens: number; outputTokens: number } {
  let micros = BigInt(0);
  let unresolved = false;
  let unknownSends = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const exchange of exchanges) {
    const sentWithoutUsage = exchange.unresolvedUsage && (exchange.status === 0 || (exchange.status >= 200 && exchange.status < 300));
    if (!exchange.usage) {
      if (sentWithoutUsage) {
        unresolved = true;
        unknownSends += 1;
      }
      continue;
    }
    if (sentWithoutUsage) unresolved = true;
    inputTokens += exchange.usage.inputTokens?.total ?? 0;
    outputTokens += exchange.usage.outputTokens?.total ?? 0;
    try {
      micros += callCostMicros("claude-haiku-5-5", exchange.usage);
    } catch {
      unresolved = true;
      unknownSends += 1;
    }
  }
  return { micros, unresolved, unknownSends, inputTokens, outputTokens };
}

async function waitSettled(storeId: string, cartId: string, messageId: string, timeoutMs: number): Promise<{ status: string; messages: Array<Record<string, unknown>>; conversationId: string } | null> {
  if (!cartId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await storeScoped(storeId).aiConversation.findFirst({ where: { storeId, cartId } });
    const messages = Array.isArray(row?.messages) ? row.messages as Array<Record<string, unknown>> : [];
    const userIndex = messages.findIndex((message) => message.role === "user" && message.id === messageId);
    const assistant = userIndex >= 0 ? messages.slice(userIndex + 1).find((message) => message.role === "assistant") : undefined;
    const status = assistant && typeof assistant.metadata === "object" ? (assistant.metadata as { status?: string }).status : undefined;
    if (row && row.inFlightUntil == null && (status === "complete" || status === "failed")) {
      return { status, messages, conversationId: row.id };
    }
    await sleep(40);
  }
  return null;
}

async function waitStrips(storeId: string, conversationId: string, timeoutMs: number, onStart?: () => void, expectStrip = false): Promise<string[] | null> {
  onStart?.();
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await storeScoped(storeId).aiAction.count({
      where: { storeId, conversationId, tool: "grounding_strip" },
    });
    if (count !== last) {
      last = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 2_000 && !(expectStrip && count === 0)) {
      const rows = await storeScoped(storeId).aiAction.findMany({
        where: { storeId, conversationId, tool: "grounding_strip" },
      });
      return rows.map((row) => {
        const amount = (row.input as { amount?: unknown } | null)?.amount;
        return typeof amount === "string" ? amount : "";
      }).filter((amount) => amount !== "");
    }
    await sleep(100);
  }
  return null;
}

function requestFor(slug: string, text: string, id: string, ip: string, cookie: string | null): Request {
  return new Request("http://golden-eval.test/api/assistant/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "golden-eval.test",
      origin: "http://golden-eval.test",
      "x-store-slug": slug,
      "x-forwarded-for": ip,
      ...(cookie ? { cookie: `cart_id=${encodeURIComponent(cookie)}` } : {}),
    },
    body: JSON.stringify({ message: { id, role: "user", parts: [{ type: "text", text }] } }),
  });
}

function readCartCookie(response: Response): string | null {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const match = /cart_id=([^;]+)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

function defaultRetryDelay(attempt: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds != null) return retryAfterSeconds * 1000;
  return attempt <= 1 ? 5_000 : 20_000;
}

function blankCase(evalCase: EvalCase): CaseResult {
  return {
    id: evalCase.id,
    category: evalCase.category,
    pass: false,
    reason: "incomplete",
    attempts: 0,
    precision: 0,
    recall: 0,
    precisionNumerator: 0,
    precisionDenominator: 1,
    recallNumerator: 0,
    recallDenominator: 1,
    hallucinated: [],
    strippedAmounts: [],
    ungroundedAmountsShown: [],
    temporalViolations: [],
    gapsReported: false,
    safetyFailures: [],
    stickyIntegrity: false,
    finalCart: [],
    steps: 0,
    stepLimitHit: false,
    toolInputErrors: 0,
    quantityChecks: evalCase.qty?.length ?? 0,
    quantityHits: 0,
    gapRequired: evalCase.gaps.length > 0,
    costMicros: "0",
    anthropicRequestIds: [],
    requestProvenance: [],
  };
}

function emptyResult(): RunResult {
  return {
    complete: false,
    incompleteReason: null,
    cases: [],
    sessionUser: "",
    spendMicros: BigInt(0),
    unresolvedSpend: false,
    ledgerDeltaMicros: null,
    conversationMicros: BigInt(0),
    inputTokens: 0,
    outputTokens: 0,
    cleanupError: null,
  };
}

async function readLedger(): Promise<bigint> {
  const { assistantSpendState } = await import("../spend");
  const state = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
  return state.spentMicros;
}

const logLines = new Map<string, string[]>();

function installAssistantLogWatch(): { unattributed: string[]; restore: () => void } {
  const unattributed: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map((item) => (typeof item === "string" ? item : "")).join(" ");
    if (line.includes("[assistant]")) {
      const id = attemptStore.getStore();
      if (!id) unattributed.push(line);
      else {
        const list = logLines.get(id) ?? [];
        list.push(line);
        logLines.set(id, list);
      }
    }
    original.apply(console, args);
  };
  return {
    unattributed,
    restore: () => {
      console.error = original;
      logLines.clear();
    },
  };
}

function attemptLogs(id: string): string[] {
  return logLines.get(id) ?? [];
}

interface ReserveHolds {
  open: number;
}

interface Budget {
  admit: (holds: ReserveHolds) => Promise<boolean>;
  admitRetry: (holds: ReserveHolds) => Promise<boolean>;
  finishAttempt: (holds: ReserveHolds, unknownSends: number, knownMicros: bigint) => Promise<void>;
  ticketBlocked: boolean;
}

function createBudget(options: RunEvalOptions): Budget {
  let spent = BigInt(0);
  let inflight = BigInt(0);
  let chain = Promise.resolve();
  let ticketBlocked = false;
  const ticketUsed = () => options.priorTicketMicros + spent + inflight;
  const run = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    get ticketBlocked() {
      return ticketBlocked;
    },
    admit: (holds) => run(() => {
      const overTicket = ticketUsed() + RESERVE_MICROS > options.ticketCapMicros;
      const overRun = spent + inflight + RESERVE_MICROS > options.maxMicros;
      if (overTicket || overRun) {
        ticketBlocked = overTicket;
        return false;
      }
      if (options.ticketSpendPath && !tryReserveTicket(RESERVE_MICROS, options.ticketCapMicros, options.ticketSpendPath)) {
        ticketBlocked = true;
        return false;
      }
      inflight += RESERVE_MICROS;
      holds.open += 1;
      return true;
    }),
    admitRetry: (holds) => run(() => {
      const overTicket = ticketUsed() + RESERVE_MICROS > options.ticketCapMicros;
      const overRun = spent + inflight + RESERVE_MICROS > options.maxMicros;
      if (overTicket || overRun) {
        ticketBlocked = overTicket;
        return false;
      }
      if (options.ticketSpendPath && !tryReserveTicket(RESERVE_MICROS, options.ticketCapMicros, options.ticketSpendPath)) {
        ticketBlocked = true;
        return false;
      }
      inflight += RESERVE_MICROS;
      holds.open += 1;
      return true;
    }),
    finishAttempt: (holds, unknownSends, knownMicros) => run(() => {
      if (holds.open <= 0) return;
      const open = holds.open;
      holds.open = 0;
      const safe = knownMicros < BigInt(0) ? BigInt(0) : knownMicros;
      const unknown = unknownSends > 0 ? unknownSends : 0;
      const held = RESERVE_MICROS * BigInt(open);
      if (inflight >= held) inflight -= held;
      else inflight = BigInt(0);
      spent += safe;
      if (options.ticketSpendPath && safe > BigInt(0)) adjustTicketSpend(safe, options.ticketSpendPath);
      if (unknown > open) {
        spent += RESERVE_MICROS * BigInt(unknown);
        if (options.ticketSpendPath) adjustTicketSpend(RESERVE_MICROS * BigInt(unknown - open), options.ticketSpendPath);
        return;
      }
      if (unknown > 0) spent += RESERVE_MICROS * BigInt(unknown);
      const release = RESERVE_MICROS * BigInt(open - unknown);
      if (options.ticketSpendPath && release > BigInt(0)) adjustTicketSpend(-release, options.ticketSpendPath);
    }),
  };
}

interface StripWatch {
  storeId: string;
  conversationId: string;
  caseId: string;
}

function amountsMissingFromSaved(exchanges: RecordedExchange[], messages: Array<Record<string, unknown>>): boolean {
  const saved = messages.filter((message) => message.role === "assistant").flatMap(assistantText).join("\n");
  const raw = exchanges.map((exchange) => exchange.text).join("\n");
  return usdMentions(raw).some((mention) => !saved.includes(mention.trim()));
}

function failedToolInput(output: unknown): boolean {
  if (!output || typeof output !== "object") return false;
  const record = output as { ok?: unknown; error?: unknown };
  return record.ok === false || (record.error != null && record.error !== false);
}

async function drainStrips(watches: StripWatch[], result: RunResult, timeoutMs: number): Promise<boolean> {
  let lost = false;
  for (const watch of watches) {
    const later = await waitStrips(watch.storeId, watch.conversationId, timeoutMs);
    const item = result.cases.find((entry) => entry.id === watch.caseId);
    if (!later) {
      lost = true;
      continue;
    }
    if (!item) continue;
    for (const amount of later) {
      if (!item.strippedAmounts.includes(amount)) item.strippedAmounts.push(amount);
    }
  }
  return lost;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
