/**
 * In-memory fake of the DynamoDB Document client (`send(command)`), faithful to the semantics DynamoRepo relies on:
 * Get/Put/Update/Delete/Query (table + GSI1, pagination, begins_with/between/comparisons on SK, filters),
 * TransactWrite (Put/Update/Delete/ConditionCheck, all-or-nothing, CancellationReasons).
 * Expression subsets: Condition/Filter/KeyCondition (AND/OR/NOT, parentheses, = <> < <= > >=, BETWEEN, IN,
 * attribute_exists, attribute_not_exists, attribute_type, begins_with, contains, size) and
 * Update (SET with + - list_append if_not_exists, REMOVE, ADD for numbers). Anything else throws loudly.
 * Also mimics real validation: unused/undefined ExpressionAttributeNames/Values, reserved words used without alias,
 * overlapping update paths, key attribute changes, 400 KB item limit, 1 MB query pages.
 */
import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Item = Record<string, any>;

export class DdbError extends Error {
  [k: string]: unknown;
  constructor(name: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = name;
    Object.assign(this, extra);
  }
}
const validation = (m: string) => new DdbError('ValidationException', m);
const unsupported = (m: string) => new Error(`FakeDdb: unsupported feature: ${m}`);

const RESERVED = new Set(`ABORT ABSOLUTE ACTION ADD AFTER AGENT ALL ALLOCATE ALTER AND ANY ARE ARRAY AS ASC ASSERTION AT ATTRIBUTE AUTHORIZATION AVG BEFORE BEGIN BETWEEN BIGINT BINARY BIT BLOB BOOLEAN BOTH BREADTH BUCKET BULK BY BYTE CALL CASCADE CASE CAST CATALOG CHAR CHECK CLASS CLOB CLOSE CLUSTER COLLATE COLLATION COLLECTION COLUMN COMMENT COMMIT COMPLETE CONNECT CONNECTION CONSTRAINT CONSTRAINTS CONTINUE COUNT CREATE CROSS CURRENT CURSOR CYCLE DATA DATABASE DATE DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT DEFERRED DELETE DEPTH DESC DESCRIBE DISTINCT DO DOMAIN DOUBLE DROP DUMP DURATION DYNAMIC EACH ELEMENT ELSE END ESCAPE EXCEPT EXCEPTION EXEC EXECUTE EXISTS EXIT EXPLAIN FILE FILTER FIRST FLOAT FOR FOREIGN FOUND FROM FULL FUNCTION GENERAL GET GLOBAL GO GOTO GRANT GROUP HASH HAVING HOUR IDENTITY IF IGNORE IMMEDIATE IN INDEX INDEXES INDICATOR INITIALLY INNER INPUT INSENSITIVE INSERT INT INTEGER INTERSECT INTERVAL INTO IS ISOLATION ITEM ITEMS KEY KEYS LANGUAGE LARGE LAST LEADING LEFT LEVEL LIKE LIMIT LIST LOCAL LOCATION LOCATOR LOG LONG LOOP MAP MATCH MAX MEMBER MERGE METHOD MIN MINUTE MODIFY MODULE MONTH MULTISET NAME NAMES NATIONAL NATURAL NCHAR NEW NEXT NO NONE NOT NULL NUMBER NUMERIC OBJECT OF OFFLINE OFFSET OLD ON ONLINE ONLY OPEN OPTION OR ORDER OUTPUT OVER OWNER PAD PARTIAL PARTITION PATH PERCENT PLAN POSITION PRECISION PREPARE PRIMARY PRIOR PRIVILEGES PROCEDURE PUBLIC RANGE READ REAL RECORD REF REFERENCE REFERENCES RELATIVE REMOVE RENAME REPLACE RESOURCE RESTRICT RESULT RETURN RETURNS REVOKE RIGHT ROLE ROLLBACK ROLLUP ROW ROWS SCAN SCHEMA SCROLL SECOND SECTION SELECT SESSION SET SHARE SIZE SMALLINT SOURCE SPACE SQL STATE STATUS STORAGE STRING STRUCTURE SUM SYNONYM SYSTEM TABLE TEMPORARY TEXT THEN TIME TIMESTAMP TIMEZONE TO TOKEN TOTAL TRANSACTION TRANSFORM TRIGGER TRUE TTL TYPE UNDER UNION UNIQUE UNKNOWN UNLOGGED UNTIL UPDATE UPPER USAGE USER USING UUID VALUE VALUES VARCHAR VARIABLE VIEW VIEWS WHEN WHENEVER WHERE WHILE WINDOW WITH WITHIN WITHOUT WORK WRAPPED WRITE YEAR ZONE`.split(/\s+/));

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

// ------------------------------------------------------------------ tokenizer
type Tok = { t: 'id' | 'name' | 'val' | 'op' | 'lp' | 'rp' | 'comma' | 'dot' | 'eof'; v: string };
function tokenize(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ t: 'lp', v: c }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp', v: c }); i++; continue; }
    if (c === ',') { out.push({ t: 'comma', v: c }); i++; continue; }
    if (c === '.') { out.push({ t: 'dot', v: c }); i++; continue; }
    if (c === '[' || c === ']') throw unsupported('list index paths in expressions');
    const two = expr.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('=<>+-'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    const m = /^[#:]?[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
    if (!m) throw validation(`Invalid expression: unexpected character '${c}' in "${expr}"`);
    const v = m[0];
    out.push({ t: v[0] === '#' ? 'name' : v[0] === ':' ? 'val' : 'id', v });
    i += v.length;
  }
  out.push({ t: 'eof', v: '' });
  return out;
}

interface Ctx {
  names: Record<string, string>;
  values: Record<string, any>;
  usedNames: Set<string>;
  usedValues: Set<string>;
}
function makeCtx(names?: Record<string, string>, values?: Record<string, any>): Ctx {
  return { names: names ?? {}, values: values ?? {}, usedNames: new Set(), usedValues: new Set() };
}
function checkUnused(ctx: Ctx) {
  for (const k of Object.keys(ctx.names)) {
    if (!ctx.usedNames.has(k)) throw validation(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${k}}`);
  }
  for (const k of Object.keys(ctx.values)) {
    if (!ctx.usedValues.has(k)) throw validation(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${k}}`);
  }
}

// ------------------------------------------------------------------ parser (shared)
class Parser {
  private toks: Tok[];
  private p = 0;
  constructor(expr: string, readonly ctx: Ctx) { this.toks = tokenize(expr); }
  peek(o = 0) { return this.toks[Math.min(this.p + o, this.toks.length - 1)]; }
  next() { return this.toks[this.p++]; }
  isKw(kw: string, o = 0) { const t = this.peek(o); return t.t === 'id' && t.v.toUpperCase() === kw; }
  eatKw(kw: string) { if (this.isKw(kw)) { this.p++; return true; } return false; }
  expect(t: Tok['t'], v?: string) {
    const k = this.next();
    if (k.t !== t || (v !== undefined && k.v !== v)) throw validation(`Invalid expression: expected ${v ?? t} but found '${k.v}'`);
    return k;
  }
  atEnd() { return this.peek().t === 'eof'; }

  /** A (possibly dotted) attribute path -> array of attribute names. */
  path(): string[] {
    const out: string[] = [];
    const one = () => {
      const k = this.next();
      if (k.t === 'name') {
        if (!(k.v in this.ctx.names)) throw validation(`An expression attribute name used in the document path is not defined; attribute name: ${k.v}`);
        this.ctx.usedNames.add(k.v);
        out.push(this.ctx.names[k.v]);
      } else if (k.t === 'id') {
        if (RESERVED.has(k.v.toUpperCase())) throw validation(`Attribute name is a reserved keyword; reserved keyword: ${k.v}`);
        out.push(k.v);
      } else throw validation(`Invalid expression: expected attribute path, found '${k.v}'`);
    };
    one();
    while (this.peek().t === 'dot') { this.next(); one(); }
    return out;
  }
  valueRef(): any {
    const k = this.expect('val');
    if (!(k.v in this.ctx.values)) throw validation(`An expression attribute value used in expression is not defined; attribute value: ${k.v}`);
    this.ctx.usedValues.add(k.v);
    return this.ctx.values[k.v];
  }
}

type Operand = (item: Item | undefined) => any; // undefined = missing attribute
type Pred = (item: Item | undefined) => boolean;

function getPath(item: Item | undefined, path: string[]): any {
  let cur: any = item;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}
const typeOf = (v: any): string =>
  typeof v === 'string' ? 'S' : typeof v === 'number' ? 'N' : typeof v === 'boolean' ? 'BOOL' : v === null ? 'NULL'
    : Array.isArray(v) ? 'L' : v instanceof Set ? 'SS' : typeof v === 'object' ? 'M' : '?';

function cmp(op: string, a: any, b: any): boolean {
  if (a === undefined || b === undefined) return op === '<>' && !(a === undefined && b === undefined);
  if (op === '=' || op === '<>') {
    const eq = JSON.stringify(a) === JSON.stringify(b);
    return op === '=' ? eq : !eq;
  }
  if (typeOf(a) !== typeOf(b) || !['S', 'N'].includes(typeOf(a))) return false;
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
  }
  throw unsupported(`operator ${op}`);
}

class CondParser extends Parser {
  parse(): Pred {
    const p = this.or();
    if (!this.atEnd()) throw validation(`Invalid ConditionExpression: unexpected token '${this.peek().v}'`);
    return p;
  }
  private or(): Pred {
    let l = this.and();
    while (this.eatKw('OR')) { const a = l; const b = this.and(); l = (i) => a(i) || b(i); }
    return l;
  }
  private and(): Pred {
    let l = this.not();
    while (this.eatKw('AND')) { const a = l; const b = this.not(); l = (i) => a(i) && b(i); }
    return l;
  }
  private not(): Pred {
    if (this.eatKw('NOT')) { const a = this.not(); return (i) => !a(i); }
    return this.primary();
  }
  private primary(): Pred {
    if (this.peek().t === 'lp') { this.next(); const p = this.or(); this.expect('rp'); return p; }
    const t = this.peek();
    if (t.t === 'id' && this.peek(1).t === 'lp') {
      const fn = t.v;
      if (fn === 'attribute_exists' || fn === 'attribute_not_exists') {
        this.next(); this.next(); const path = this.path(); this.expect('rp');
        return fn === 'attribute_exists' ? (i) => getPath(i, path) !== undefined : (i) => getPath(i, path) === undefined;
      }
      if (fn === 'attribute_type') {
        this.next(); this.next(); const path = this.path(); this.expect('comma'); const ty = this.valueRef(); this.expect('rp');
        return (i) => { const v = getPath(i, path); return v !== undefined && typeOf(v) === ty; };
      }
      if (fn === 'begins_with' || fn === 'contains') {
        this.next(); this.next(); const a = this.operand(); this.expect('comma'); const b = this.operand(); this.expect('rp');
        if (fn === 'begins_with') return (i) => { const x = a(i), y = b(i); return typeof x === 'string' && typeof y === 'string' && x.startsWith(y); };
        return (i) => {
          const x = a(i), y = b(i);
          return typeof x === 'string' ? typeof y === 'string' && x.includes(y) : Array.isArray(x) && x.some((e) => JSON.stringify(e) === JSON.stringify(y));
        };
      }
      if (fn !== 'size') throw unsupported(`function ${fn}`);
    }
    const left = this.operand();
    const k = this.peek();
    if (k.t === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(k.v)) {
      this.next(); const right = this.operand();
      return (i) => cmp(k.v, left(i), right(i));
    }
    if (this.isKw('BETWEEN')) {
      this.next(); const lo = this.operand();
      if (!this.eatKw('AND')) throw validation('BETWEEN requires AND');
      const hi = this.operand();
      return (i) => cmp('>=', left(i), lo(i)) && cmp('<=', left(i), hi(i));
    }
    if (this.isKw('IN')) {
      this.next(); this.expect('lp'); const opts: Operand[] = [this.operand()];
      while (this.peek().t === 'comma') { this.next(); opts.push(this.operand()); }
      this.expect('rp');
      return (i) => opts.some((o) => cmp('=', left(i), o(i)));
    }
    throw validation(`Invalid ConditionExpression: expected a comparison near '${k.v}'`);
  }
  operand(): Operand {
    const t = this.peek();
    if (t.t === 'val') { const v = this.valueRef(); return () => v; }
    if (t.t === 'id' && t.v === 'size' && this.peek(1).t === 'lp') {
      this.next(); this.next(); const path = this.path(); this.expect('rp');
      return (i) => {
        const v = getPath(i, path);
        if (typeof v === 'string' || Array.isArray(v)) return v.length;
        if (v && typeof v === 'object') return Object.keys(v).length;
        return undefined;
      };
    }
    const path = this.path();
    return (i) => getPath(i, path);
  }
}

function compileCondition(expr: string | undefined, ctx: Ctx): Pred {
  if (!expr) return () => true;
  return new CondParser(expr, ctx).parse();
}

// ------------------------------------------------------------------ update expressions
type UpdateOp =
  | { kind: 'set'; path: string[]; value: (item: Item) => any }
  | { kind: 'remove'; path: string[] }
  | { kind: 'add'; path: string[]; value: number };

class UpdateParser extends Parser {
  parse(): UpdateOp[] {
    const ops: UpdateOp[] = [];
    while (!this.atEnd()) {
      const kw = this.next();
      const K = kw.v.toUpperCase();
      if (kw.t !== 'id' || !['SET', 'REMOVE', 'ADD', 'DELETE'].includes(K)) throw validation(`Invalid UpdateExpression: unexpected '${kw.v}'`);
      if (K === 'DELETE') throw unsupported('UpdateExpression DELETE clause');
      do {
        if (this.peek().t === 'comma') this.next();
        if (K === 'SET') {
          const path = this.path(); this.expect('op', '=');
          ops.push({ kind: 'set', path, value: this.setValue() });
        } else if (K === 'REMOVE') ops.push({ kind: 'remove', path: this.path() });
        else {
          const path = this.path(); const v = this.valueRef();
          if (typeof v !== 'number') throw unsupported('ADD with non-number (sets)');
          ops.push({ kind: 'add', path, value: v });
        }
      } while (this.peek().t === 'comma');
    }
    return ops;
  }
  private setValue(): (item: Item) => any {
    const l = this.setOperand();
    const k = this.peek();
    if (k.t === 'op' && (k.v === '+' || k.v === '-')) {
      this.next(); const r = this.setOperand();
      return (item) => {
        const a = l(item), b = r(item);
        if (typeof a !== 'number' || typeof b !== 'number') throw validation('An operand in the update expression has an incorrect data type');
        return k.v === '+' ? a + b : a - b;
      };
    }
    return l;
  }
  private setOperand(): (item: Item) => any {
    const t = this.peek();
    if (t.t === 'val') { const v = this.valueRef(); return () => clone(v); }
    if (t.t === 'id' && this.peek(1).t === 'lp') {
      this.next(); this.next();
      if (t.v === 'if_not_exists') {
        const path = this.path(); this.expect('comma'); const d = this.setOperand(); this.expect('rp');
        return (item) => { const cur = getPath(item, path); return cur !== undefined ? cur : d(item); };
      }
      if (t.v === 'list_append') {
        const a = this.setOperand(); this.expect('comma'); const b = this.setOperand(); this.expect('rp');
        return (item) => {
          const x = a(item), y = b(item);
          if (!Array.isArray(x) || !Array.isArray(y)) throw validation('list_append requires list operands');
          return [...x, ...y];
        };
      }
      throw unsupported(`update function ${t.v}`);
    }
    const path = this.path();
    return (item) => {
      const v = getPath(item, path);
      if (v === undefined) throw validation('The provided expression refers to an attribute that does not exist in the item');
      return clone(v);
    };
  }
}

function setPath(item: Item, path: string[], value: any) {
  let cur = item;
  for (let i = 0; i < path.length - 1; i++) {
    const nx = cur[path[i]];
    if (nx === null || typeof nx !== 'object' || Array.isArray(nx)) throw validation('The document path provided in the update expression is invalid for update');
    cur = nx;
  }
  cur[path[path.length - 1]] = value;
}
function removePath(item: Item, path: string[]) {
  const parent = path.length === 1 ? item : getPath(item, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete parent[path[path.length - 1]];
}

function applyUpdate(existing: Item | undefined, key: Item, ops: UpdateOp[]): Item {
  const item: Item = existing ? clone(existing) : { ...clone(key) };
  const seen: string[][] = [];
  for (const op of ops) {
    for (const s of seen) {
      const n = Math.min(s.length, op.path.length);
      if (s.slice(0, n).join('\u0000') === op.path.slice(0, n).join('\u0000')) {
        throw validation('Two document paths overlap with each other; must remove or rewrite one of these paths');
      }
    }
    seen.push(op.path);
    if (op.path.length === 1 && op.path[0] in key) {
      throw validation(`One or more parameter values were invalid: Cannot update attribute ${op.path[0]}. This attribute is part of the key`);
    }
  }
  // all right-hand sides are evaluated against the ORIGINAL item
  const orig = existing ?? { ...key };
  const computed = ops.map((op) => (op.kind === 'set' ? op.value(orig) : undefined));
  ops.forEach((op, idx) => {
    if (op.kind === 'set') setPath(item, op.path, computed[idx]);
    else if (op.kind === 'remove') removePath(item, op.path);
    else {
      const cur = getPath(item, op.path);
      if (cur !== undefined && typeof cur !== 'number') throw validation('An operand in the update expression has an incorrect data type');
      setPath(item, op.path, (cur ?? 0) + op.value);
    }
  });
  return item;
}

// ------------------------------------------------------------------ the table
function stripUndefined(v: any): any {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object' && !(v instanceof Set)) {
    const o: Item = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = stripUndefined(x);
    return o;
  }
  return v;
}
function assertNoUndefined(v: any, where: string) {
  if (v === undefined) throw new Error(`Pass options.removeUndefinedValues=true to remove undefined values from map/array/set (${where}).`);
  if (Array.isArray(v)) v.forEach((x) => assertNoUndefined(x, where));
  else if (v && typeof v === 'object' && !(v instanceof Set)) Object.entries(v).forEach(([k, x]) => assertNoUndefined(x, `${where}.${k}`));
}

export interface FakeDdbOptions {
  tableName?: string;
  /** Mirrors DynamoDBDocumentClient marshallOptions.removeUndefinedValues (the production factory sets true). */
  removeUndefinedValues?: boolean;
  /** Max bytes of items scanned per Query page (real: 1 MB). Lower it in tests to force pagination. */
  pageBytes?: number;
  /** Optional hook run before each command executes; throw to inject failures. */
  beforeSend?: (command: unknown) => void | Promise<void>;
}

const GSI_ATTRS: Record<string, [string, string]> = { GSI1: ['GSI1PK', 'GSI1SK'] };
const MAX_ITEM_BYTES = 400 * 1024;
function cmpStr(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

export class FakeDdb {
  readonly items = new Map<string, Item>();
  readonly commands: { name: string; input: any }[] = [];
  readonly tableName: string;
  readonly opts: { removeUndefinedValues: boolean; pageBytes: number; beforeSend?: FakeDdbOptions['beforeSend'] };

  constructor(o: FakeDdbOptions = {}) {
    this.tableName = o.tableName ?? 'hp-test-game';
    this.opts = { removeUndefinedValues: o.removeUndefinedValues ?? true, pageBytes: o.pageBytes ?? 1024 * 1024, beforeSend: o.beforeSend };
  }

  // ----- inspection helpers for tests
  all(): Item[] { return [...this.items.values()].map(clone); }
  get(pk: string, sk: string): Item | undefined { return clone(this.items.get(this.k(pk, sk))); }
  count(name?: string) { return this.commands.filter((c) => !name || c.name === name).length; }

  private k(pk: string, sk: string) { return `${pk}\u0000${sk}`; }
  private keyOf(key: Item, what = 'Key'): [string, string] {
    if (!key || typeof key.PK !== 'string' || typeof key.SK !== 'string' || Object.keys(key).length !== 2) {
      throw validation(`The provided key element does not match the schema (${what}: ${JSON.stringify(key)})`);
    }
    return [key.PK, key.SK];
  }
  private checkTable(name: unknown) {
    if (name !== this.tableName) throw new DdbError('ResourceNotFoundException', `Requested resource not found (table ${String(name)})`);
  }
  private prepItem(raw: Item): Item {
    const item = this.opts.removeUndefinedValues ? stripUndefined(raw) : (assertNoUndefined(raw, 'Item'), raw);
    if (typeof item.PK !== 'string' || typeof item.SK !== 'string') throw validation('One or more parameter values were invalid: Missing the key PK/SK in the item');
    if (item.ttl !== undefined && typeof item.ttl !== 'number') throw validation('TTL attribute must be a number');
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES) throw validation('Item size has exceeded the maximum allowed size');
    for (const [a, b] of Object.values(GSI_ATTRS)) {
      if (item[a] !== undefined && typeof item[a] !== 'string') throw validation(`Type mismatch for Index Key ${a}`);
      if (item[b] !== undefined && typeof item[b] !== 'string') throw validation(`Type mismatch for Index Key ${b}`);
    }
    return clone(item);
  }

  async send(command: any): Promise<any> {
    const name: string = command?.constructor?.name ?? 'unknown';
    this.commands.push({ name, input: clone(command?.input) });
    await Promise.resolve(); // yield, so concurrent callers genuinely interleave between commands
    if (this.opts.beforeSend) await this.opts.beforeSend(command);
    // everything below is synchronous => each command is atomic, like DynamoDB's per-item / transaction guarantees
    if (command instanceof GetCommand) return this.doGet(command.input);
    if (command instanceof PutCommand) return this.doPut(command.input);
    if (command instanceof UpdateCommand) return this.doUpdate(command.input);
    if (command instanceof DeleteCommand) return this.doDelete(command.input);
    if (command instanceof QueryCommand) return this.doQuery(command.input);
    if (command instanceof TransactWriteCommand) return this.doTransact(command.input);
    throw unsupported(`command ${name}`);
  }

  private rejectExtra(input: any, allowed: string[], what: string) {
    for (const k of Object.keys(input)) {
      if (input[k] !== undefined && !allowed.includes(k)) throw unsupported(`${what} parameter ${k}`);
    }
  }

  private doGet(input: any) {
    this.rejectExtra(input, ['TableName', 'Key', 'ConsistentRead'], 'GetItem');
    this.checkTable(input.TableName);
    const [pk, sk] = this.keyOf(input.Key);
    const it = this.items.get(this.k(pk, sk));
    return { Item: it ? clone(it) : undefined, $metadata: {} };
  }

  private condFail(item: Item | undefined) {
    return new DdbError('ConditionalCheckFailedException', 'The conditional request failed', { Item: item ? clone(item) : undefined });
  }

  private doPut(input: any) {
    this.rejectExtra(input, ['TableName', 'Item', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'], 'PutItem');
    this.checkTable(input.TableName);
    const item = this.prepItem(input.Item);
    const ctx = makeCtx(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const cond = compileCondition(input.ConditionExpression, ctx);
    checkUnused(ctx);
    const existing = this.items.get(this.k(item.PK, item.SK));
    if (!cond(existing)) throw this.condFail(existing);
    this.items.set(this.k(item.PK, item.SK), item);
    return { $metadata: {} };
  }

  private planUpdate(input: any): { key: [string, string]; next: Item } {
    this.rejectExtra(input, ['TableName', 'Key', 'UpdateExpression', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'], 'UpdateItem');
    this.checkTable(input.TableName);
    const [pk, sk] = this.keyOf(input.Key);
    const ctx = makeCtx(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const cond = compileCondition(input.ConditionExpression, ctx);
    const ops = input.UpdateExpression ? new UpdateParser(input.UpdateExpression, ctx).parse() : [];
    checkUnused(ctx);
    const existing = this.items.get(this.k(pk, sk));
    if (!cond(existing)) throw this.condFail(existing);
    const next = this.prepItem(applyUpdate(existing, { PK: pk, SK: sk }, ops));
    return { key: [pk, sk], next };
  }
  private doUpdate(input: any) {
    const { key, next } = this.planUpdate(input);
    this.items.set(this.k(...key), next);
    return { $metadata: {} };
  }

  private planDelete(input: any): [string, string] {
    this.rejectExtra(input, ['TableName', 'Key', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'], 'DeleteItem');
    this.checkTable(input.TableName);
    const [pk, sk] = this.keyOf(input.Key);
    const ctx = makeCtx(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const cond = compileCondition(input.ConditionExpression, ctx);
    checkUnused(ctx);
    const existing = this.items.get(this.k(pk, sk));
    if (!cond(existing)) throw this.condFail(existing);
    return [pk, sk];
  }
  private doDelete(input: any) {
    this.items.delete(this.k(...this.planDelete(input)));
    return { $metadata: {} };
  }

  private doQuery(input: any) {
    this.rejectExtra(input, ['TableName', 'IndexName', 'KeyConditionExpression', 'FilterExpression', 'ExpressionAttributeNames',
      'ExpressionAttributeValues', 'ExclusiveStartKey', 'Limit', 'ConsistentRead', 'ScanIndexForward'], 'Query');
    this.checkTable(input.TableName);
    let pkAttr = 'PK', skAttr = 'SK';
    if (input.IndexName) {
      const g = GSI_ATTRS[input.IndexName];
      if (!g) throw validation(`The table does not have the specified index: ${input.IndexName}`);
      if (input.ConsistentRead) throw validation('Consistent reads are not supported on global secondary indexes');
      [pkAttr, skAttr] = g;
    }
    if (!input.KeyConditionExpression) throw validation('Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.');
    const ctx = makeCtx(input.ExpressionAttributeNames, input.ExpressionAttributeValues);
    const keyPred = compileCondition(input.KeyConditionExpression, ctx);
    const filter = compileCondition(input.FilterExpression, ctx);
    checkUnused(ctx);
    // KeyConditionExpression must pin the partition key with equality and cannot use OR
    const resolved = (input.KeyConditionExpression as string).replace(/#\w+/g, (m) => ctx.names[m] ?? m);
    if (!new RegExp(`(^|\\s|\\()${pkAttr}\\s*=\\s*:`).test(resolved)) throw validation(`Query condition missed key schema element: ${pkAttr}`);
    if (/\bOR\b/i.test(resolved)) throw validation('KeyConditionExpression cannot contain OR');

    const rows = [...this.items.values()]
      .filter((it) => typeof it[pkAttr] === 'string' && typeof it[skAttr] === 'string')
      .filter((it) => keyPred(it)) // the key condition narrows the range BEFORE Limit / page size apply (unlike FilterExpression)
      .sort((a, b) => cmpStr(a[pkAttr], b[pkAttr]) || cmpStr(a[skAttr], b[skAttr]) || cmpStr(a.PK, b.PK) || cmpStr(a.SK, b.SK));
    if (input.ScanIndexForward === false) rows.reverse();
    let start = 0;
    if (input.ExclusiveStartKey) {
      const esk = input.ExclusiveStartKey;
      const idx = rows.findIndex((r) => r.PK === esk.PK && r.SK === esk.SK);
      if (idx < 0) throw validation('The provided starting key is invalid');
      start = idx + 1;
    }
    const out: Item[] = [];
    let bytes = 0, scanned = 0, last: Item | undefined, lastEvaluated: Item | undefined;
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if ((input.Limit !== undefined && scanned >= input.Limit) || bytes >= this.opts.pageBytes) { lastEvaluated = last; break; }
      scanned++;
      bytes += Buffer.byteLength(JSON.stringify(r));
      last = r;
      if (filter(r)) out.push(clone(r));
    }
    const lek = lastEvaluated
      ? Object.fromEntries(['PK', 'SK', ...(input.IndexName ? [pkAttr, skAttr] : [])].map((a) => [a, lastEvaluated![a]]))
      : undefined;
    return { Items: out, Count: out.length, ScannedCount: scanned, LastEvaluatedKey: lek, $metadata: {} };
  }

  private doTransact(input: any) {
    this.rejectExtra(input, ['TransactItems'], 'TransactWriteItems');
    const txs: any[] = input.TransactItems;
    if (!txs?.length || txs.length > 100) throw validation('Member must have length less than or equal to 100 (and at least 1)');
    const seen = new Set<string>();
    const reasons: { Code: string; Message?: string }[] = [];
    const writes: (() => void)[] = [];
    let failed = false;
    for (const t of txs) {
      const kinds = Object.keys(t).filter((k) => t[k] !== undefined);
      if (kinds.length !== 1 || !['Put', 'Update', 'Delete', 'ConditionCheck'].includes(kinds[0])) {
        throw validation('TransactItems member must contain exactly one of Put/Update/Delete/ConditionCheck');
      }
      const kind = kinds[0];
      const body = t[kind];
      this.checkTable(body.TableName);
      const key: [string, string] = kind === 'Put' ? this.keyOf({ PK: body.Item?.PK, SK: body.Item?.SK }, 'Item') : this.keyOf(body.Key);
      const kk = this.k(...key);
      if (seen.has(kk)) throw validation('Transaction request cannot include multiple operations on one item');
      seen.add(kk);

      const existing = this.items.get(kk);
      try {
        if (kind === 'Put') {
          this.rejectExtra(body, ['TableName', 'Item', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'], 'Transact Put');
          const item = this.prepItem(body.Item);
          const ctx = makeCtx(body.ExpressionAttributeNames, body.ExpressionAttributeValues);
          const cond = compileCondition(body.ConditionExpression, ctx); checkUnused(ctx);
          if (!cond(existing)) throw this.condFail(existing);
          writes.push(() => this.items.set(kk, item));
        } else if (kind === 'Update') {
          const { next } = this.planUpdate(body);
          writes.push(() => this.items.set(kk, next));
        } else if (kind === 'Delete') {
          this.planDelete(body);
          writes.push(() => this.items.delete(kk));
        } else {
          this.rejectExtra(body, ['TableName', 'Key', 'ConditionExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues'], 'ConditionCheck');
          if (!body.ConditionExpression) throw validation('ConditionCheck requires ConditionExpression');
          const ctx = makeCtx(body.ExpressionAttributeNames, body.ExpressionAttributeValues);
          const cond = compileCondition(body.ConditionExpression, ctx); checkUnused(ctx);
          if (!cond(existing)) throw this.condFail(existing);
        }
        reasons.push({ Code: 'None' });
      } catch (e) {
        if ((e as DdbError).name === 'ConditionalCheckFailedException') {
          failed = true;
          reasons.push({ Code: 'ConditionalCheckFailed', Message: 'The conditional request failed' });
        } else throw e;
      }
    }
    if (failed) {
      throw new DdbError('TransactionCanceledException',
        `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(', ')}]`,
        { CancellationReasons: reasons });
    }
    writes.forEach((w) => w());
    return { $metadata: {} };
  }
}
