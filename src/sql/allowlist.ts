// What sql_query accepts. Anything not listed here is refused (fail closed), so a parser upgrade
// that adds new syntax cannot make it executable without review.

export const READABLE_TABLES: ReadonlySet<string> = new Set([
  'brand', 'wiki_page', 'wiki_revision', 'wiki_link', 'change_log',
  'item', 'item_uom_conversion', 'document', 'document_link', 'item_identifier', 'item_pack', 'site', 'location',
  'lot', 'stock_txn', 'stock_balance', 'bom', 'bom_line', 'production_run',
  'supplier', 'supplier_address', 'contact', 'contact_method', 'supplier_item', 'supplier_offering',
  'rfq', 'rfq_line', 'rfq_recipient', 'interaction',
  'quote', 'quote_line', 'quote_line_break', 'fx_rate',
  'item_spec', 'evaluation', 'purchase_order', 'po_line', 'reorder_policy',
  'uom', 'container_type', 'contact_method_type',
]);

export const ALLOWED_NODES: ReadonlySet<string> = new Set([
  'SelectStmt', 'ResTarget', 'ColumnRef', 'A_Star', 'A_Const', 'String', 'Integer', 'Float', 'Boolean', 'TypeCast',
  'TypeName', 'A_Expr', 'BoolExpr', 'NullTest', 'BooleanTest', 'SubLink', 'RangeVar', 'Alias', 'JoinExpr',
  'RangeSubselect', 'WithClause', 'CommonTableExpr', 'SortBy', 'FuncCall', 'WindowDef', 'CaseExpr', 'CaseWhen',
  'CoalesceExpr', 'MinMaxExpr', 'SQLValueFunction', 'List', 'NamedArgExpr',
]);

export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'trunc', 'lower', 'upper', 'length',
  'btrim', 'ltrim', 'rtrim', 'trim', 'substr', 'substring', 'concat', 'concat_ws', 'replace', 'left', 'right',
  'date_trunc', 'date_part', 'extract', 'to_char', 'now', 'age', 'coalesce', 'greatest', 'least', 'nullif',
  'string_agg', 'array_agg', 'bool_and', 'bool_or', 'row_number', 'rank', 'dense_rank', 'lag', 'lead',
  'first_value', 'last_value', 'ntile', 'percentile_cont', 'percentile_disc', 'stddev', 'variance',
  'cardinality', 'array_length', 'split_part', 'position', 'strpos', 'make_interval', 'justify_interval',
]);

export const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'int2', 'int4', 'int8', 'int', 'integer', 'bigint', 'smallint', 'numeric', 'decimal', 'float4', 'float8', 'real',
  'text', 'varchar', 'bpchar', 'char', 'bool', 'boolean', 'date', 'timestamp', 'timestamptz', 'interval', 'uuid', 'time',
]);
