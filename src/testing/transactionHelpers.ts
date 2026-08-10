/**
 * Helpers for inspecting `submitAndWaitForTransactionTree` results in Canton integration tests.
 */

import {
  extractEventsFromTransaction,
  type LedgerJsonApiClient,
  type ParsedCreatedEvent,
  type ParsedExercisedEvent,
} from '@fairmint/canton-node-sdk';

type CreatedTreeEventValue = Pick<
  ParsedCreatedEvent,
  'contractId' | 'templateId' | 'createdEventBlob' | 'createArgument'
>;
type ExercisedTreeEventValue = Pick<
  ParsedExercisedEvent,
  'contractId' | 'templateId' | 'choice' | 'exerciseResult'
>;

/** Return all `CreatedTreeEvent` payloads in document order. */
export function listCreatedEvents(input: unknown): CreatedTreeEventValue[] {
  return extractEventsFromTransaction(input).created;
}

/** Return all `ExercisedTreeEvent` payloads in document order. */
export function listExercisedEvents(input: unknown): ExercisedTreeEventValue[] {
  return extractEventsFromTransaction(input).exercised;
}

/**
 * Find the first created contract whose `templateId` contains `templateNameSubstring`.
 *
 * @throws If no matching event is found.
 */
export function findCreatedContractId(input: unknown, templateNameSubstring: string): string {
  for (const created of listCreatedEvents(input)) {
    if (created.templateId.includes(templateNameSubstring)) {
      return created.contractId;
    }
  }
  throw new Error(
    `No CreatedTreeEvent with templateId containing "${templateNameSubstring}"; created templates: ` +
      `${listCreatedEvents(input)
        .map((c) => c.templateId)
        .join(', ')}`
  );
}

/** All created contract IDs whose `templateId` contains `templateNameSubstring`. */
export function findAllCreatedContractIds(input: unknown, templateNameSubstring: string): string[] {
  return listCreatedEvents(input)
    .filter((c) => c.templateId.includes(templateNameSubstring))
    .map((c) => c.contractId);
}

/**
 * Find the first exercise event matching `choiceName` and return its `exerciseResult`.
 *
 * @throws If no matching event is found.
 */
export function findExerciseResult<T = unknown>(input: unknown, choiceName: string): T | undefined {
  for (const exercised of listExercisedEvents(input)) {
    if (exercised.choice === choiceName) {
      return exercised.exerciseResult as T | undefined;
    }
  }
  throw new Error(
    `No ExercisedTreeEvent with choice "${choiceName}"; exercised choices: ` +
      `${listExercisedEvents(input)
        .map((c) => c.choice)
        .join(', ')}`
  );
}

/** Fetch the active createdEventBlob for a contract. */
export async function fetchCreatedEventBlob(
  ledger: LedgerJsonApiClient,
  contractId: string,
  readAs?: string[]
): Promise<string> {
  const events = await ledger.getEventsByContractId({
    contractId,
    ...(readAs?.length ? { readAs } : {}),
  });
  const blob = events.created?.createdEvent.createdEventBlob;
  if (!blob) {
    throw new Error(`No createdEventBlob found for contract ${contractId}`);
  }
  return blob;
}

async function fetchCreatedEventDisclosure(
  ledger: LedgerJsonApiClient,
  contractId: string,
  readAs?: string[]
): Promise<LedgerDisclosedContract> {
  const events = await ledger.getEventsByContractId({
    contractId,
    ...(readAs?.length ? { readAs } : {}),
  });
  const created = events.created?.createdEvent;
  const blob = created?.createdEventBlob;
  if (!created || !blob) {
    throw new Error(`No createdEventBlob found for contract ${contractId}`);
  }
  return {
    templateId: created.templateId,
    contractId: created.contractId,
    createdEventBlob: blob,
    synchronizerId: events.created?.synchronizerId ?? '',
  };
}

/** Disclosed contract payload for JSON API command submission. */
export interface LedgerDisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

function requireTemplateIdMatch(params: {
  contractId: string;
  actualTemplateId: string;
  expectedTemplateId: string;
}): void {
  if (
    params.actualTemplateId === params.expectedTemplateId ||
    templateDescriptor(params.actualTemplateId) === templateDescriptor(params.expectedTemplateId)
  ) {
    return;
  }
  throw new Error(
    `Contract ${params.contractId} has templateId ${params.actualTemplateId}; expected ${params.expectedTemplateId}`
  );
}

function templateDescriptor(templateId: string): string {
  return templateId.split(':').slice(1).join(':') || templateId;
}

/** Build a disclosed contract for an exercise on a contract visible to another party. */
export async function buildDisclosedContract(
  ledger: LedgerJsonApiClient,
  params: {
    contractId: string;
    templateId: string;
    synchronizerId: string;
    /** Party that can see the contract in ACS (typically transferAgent). */
    readAsParty: string;
  }
): Promise<LedgerDisclosedContract> {
  const response = await ledger.getActiveContracts({
    parties: [params.readAsParty],
    templateIds: [params.templateId],
    includeCreatedEventBlob: true,
  });
  for (const item of response) {
    const entry = item.contractEntry;
    if (!('JsActiveContract' in entry)) continue;
    const created = entry.JsActiveContract.createdEvent;
    if (created.contractId !== params.contractId) continue;
    requireTemplateIdMatch({
      contractId: params.contractId,
      actualTemplateId: created.templateId,
      expectedTemplateId: params.templateId,
    });
    const blob =
      created.createdEventBlob ??
      (await fetchCreatedEventBlob(ledger, params.contractId, [params.readAsParty]));
    return {
      templateId: created.templateId,
      contractId: params.contractId,
      createdEventBlob: blob,
      synchronizerId: params.synchronizerId,
    };
  }

  const disclosure = await fetchCreatedEventDisclosure(ledger, params.contractId, [
    params.readAsParty,
  ]);
  requireTemplateIdMatch({
    contractId: params.contractId,
    actualTemplateId: disclosure.templateId,
    expectedTemplateId: params.templateId,
  });
  return {
    ...disclosure,
    synchronizerId: disclosure.synchronizerId || params.synchronizerId,
  };
}
