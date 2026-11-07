import type { OpDef } from './types.ts';
import whoami from './context/whoami.ts';
import operationStatus from './context/operation-status.ts';
import auditList from './context/audit-list.ts';
import companyRulesGet from './context/company-rules-get.ts';
import usersList from './context/users-list.ts';
import authEventsList from './context/auth-events-list.ts';
import changeHistory from './context/change-history.ts';
import guideList from './guides/guide-list.ts';
import guideGet from './guides/guide-get.ts';
import wikiList from './wiki/wiki-list.ts';
import wikiRead from './wiki/wiki-read.ts';
import wikiSearch from './wiki/wiki-search.ts';
import wikiHistory from './wiki/wiki-history.ts';
import wikiCreate from './wiki/wiki-create.ts';
import wikiWrite from './wiki/wiki-write.ts';
import wikiAppend from './wiki/wiki-append.ts';
import wikiReplace from './wiki/wiki-replace.ts';
import wikiMove from './wiki/wiki-move.ts';
import wikiDelete from './wiki/wiki-delete.ts';
import wikiRestore from './wiki/wiki-restore.ts';
import wikiLogAppend from './wiki/wiki-log-append.ts';
import itemUpsert from './inventory/item-upsert.ts';
import itemGet from './inventory/item-get.ts';
import itemSearch from './inventory/item-search.ts';
import itemIdentifierAdd from './inventory/item-identifier-add.ts';
import itemPackUpsert from './inventory/item-pack-upsert.ts';
import itemConversionSet from './inventory/item-conversion-set.ts';
import locationUpsert from './inventory/location-upsert.ts';
import containerTypeList from './inventory/container-type-list.ts';
import stockMove from './inventory/stock-move.ts';
import stockCount from './inventory/stock-count.ts';
import stockLevels from './inventory/stock-levels.ts';
import stockHistory from './inventory/stock-history.ts';
import stockReverse from './inventory/stock-reverse.ts';
import lotStatusSet from './inventory/lot-status-set.ts';
import bomUpsert from './production/bom-upsert.ts';
import bomGet from './production/bom-get.ts';
import productionRunRecord from './production/production-run-record.ts';
import supplierUpsert from './suppliers/supplier-upsert.ts';
import supplierGet from './suppliers/supplier-get.ts';
import supplierSearch from './suppliers/supplier-search.ts';
import supplierFindDuplicates from './suppliers/supplier-find-duplicates.ts';
import supplierImport from './suppliers/supplier-import.ts';
import contactUpsert from './suppliers/contact-upsert.ts';
import contactMethodAdd from './suppliers/contact-method-add.ts';
import contactMethodUpdate from './suppliers/contact-method-update.ts';
import supplierItemUpsert from './suppliers/supplier-item-upsert.ts';
import supplierPayoutAccountSet from './suppliers/supplier-payout-account-set.ts';
import supplierOfferingUpsert from './suppliers/supplier-offering-upsert.ts';
import rfqCreate from './procurement/rfq-create.ts';
import rfqAddRecipients from './procurement/rfq-add-recipients.ts';
import { rfqGet, rfqList, rfqStatusSet } from './procurement/rfq-get.ts';
import interactionLog from './outreach/interaction-log.ts';
import outreachStatus from './outreach/outreach-status.ts';
import quoteRecord from './procurement/quote-record.ts';
import fxRateRecord from './procurement/fx-rate-record.ts';
import quoteCompare from './procurement/quote-compare.ts';
import specUpsert from './specs/spec-upsert.ts';
import specGet from './specs/spec-get.ts';
import evaluationLog from './specs/evaluation-log.ts';
import evaluationList from './specs/evaluation-list.ts';
import poCreate from './procurement/po-create.ts';
import poApprove from './procurement/po-approve.ts';
import { poPaymentInstruction, poPaymentRecord } from './procurement/po-payment.ts';
import poReceive from './procurement/po-receive.ts';
import { poGet, poStatusSet } from './procurement/po-get.ts';
import reorderPolicySet from './inventory/reorder-policy-set.ts';
import lowStockReport from './inventory/low-stock-report.ts';
import {
  documentAdd, documentCaptureText, documentGet, documentLink, documentSearch, documentsExpiring, documentUpdate,
} from './documents/document-ops.ts';
import sqlQuery from './sql/sql-query.ts';

// Operation generics differ per module; the registry stores them uniformly.
type AnyOp = OpDef<any, any>;

const ALL: AnyOp[] = [
  whoami, operationStatus, auditList, companyRulesGet, usersList, authEventsList, changeHistory, guideList, guideGet,
  wikiList, wikiRead, wikiSearch, wikiHistory, wikiCreate, wikiWrite, wikiAppend, wikiReplace, wikiMove, wikiDelete,
  wikiRestore, wikiLogAppend,
  itemUpsert, itemGet, itemSearch, itemIdentifierAdd, itemPackUpsert, itemConversionSet, locationUpsert, containerTypeList,
  stockMove, stockCount, stockLevels, stockHistory, stockReverse, lotStatusSet,
  bomUpsert, bomGet, productionRunRecord,
  supplierUpsert, supplierGet, supplierSearch, supplierFindDuplicates, supplierImport, contactUpsert, contactMethodAdd, contactMethodUpdate,
  supplierItemUpsert, supplierPayoutAccountSet, supplierOfferingUpsert,
  rfqCreate, rfqAddRecipients, rfqGet, rfqList, rfqStatusSet, interactionLog, outreachStatus,
  quoteRecord, fxRateRecord, quoteCompare,
  specUpsert, specGet, evaluationLog, evaluationList,
  poCreate, poApprove, poPaymentInstruction, poPaymentRecord, poReceive, poGet, poStatusSet,
  reorderPolicySet, lowStockReport,
  documentGet, documentLink, documentSearch, documentsExpiring, documentCaptureText, documentAdd, documentUpdate,
  sqlQuery,
];

const registry = new Map<string, AnyOp>();
for (const def of ALL) {
  if (registry.has(def.name)) throw new Error(`Duplicate operation name: ${def.name}`);
  registry.set(def.name, def);
}

export const ops: ReadonlyMap<string, AnyOp> = registry;

export function getOp(name: string): AnyOp | undefined {
  return registry.get(name);
}

// Lets tests add throwaway operations; refuses outside the test environment.
export function registerTestOp(def: AnyOp): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('registerTestOp is only available in tests.');
  registry.set(def.name, def);
}
