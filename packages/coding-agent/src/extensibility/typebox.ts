
/**
 * 极简的 `@sinclair/typebox` 运行时兼容层，底层由 Zod 实现。
 *
 * 历史上 coding-agent 会向扩展（extensions / hooks / 自定义工具 / 自定义命令）
 * 注入真正的 `@sinclair/typebox`（约 5MB 的依赖），让扩展作者可以用
 * `Type.Object({ name: Type.String() })` 这种语法定义参数 schema。
 * 但 agent 内部其实统一走 Zod（见 wire.ts、validation.ts），保留 TypeBox
 * 只是为了向后兼容扩展生态。
 *
 * 本模块用一个极小的门面替代了 typebox 注入：`Type` 上的所有 builder 都
 * 返回 Zod schema。这些 schema 在内部管线中与手写的 Zod 完全等价：
 *
 *   - `isZodSchema()` 通过每个 schema 自带的 `_zod` 标记识别 schema。
 *   - `zodToWireSchema()` 输出的 draft 2020-12 JSON Schema 与 TypeBox 写
 *     法所产生的完全一致（默认值字段视为可选等行为也一致）。
 *
 * 这个 shim 仅覆盖常用 TypeBox builder。对于使用了 `TypeCompiler`、全局
 * `TypeRegistry`、自定义 `Symbol(TypeBox.Kind)` 等冷门 API 的插件，应当
 * 在插件自身 vendor 真正的 `@sinclair/typebox`。
 *
 * Minimal `@sinclair/typebox` runtime compatibility shim, backed by Zod.
 *
 * Historically the coding agent injected the real `@sinclair/typebox` (~5MB
 * dependency) into extensions, hooks, custom tools, and custom commands so
 * they could author parameter schemas as `Type.Object({ name: Type.String() })`.
 * Internally everything already runs through Zod (`wire.ts`, `validation.ts`);
 * the only reason TypeBox remained was extension-author compat.
 *
 * This module replaces that injection with a tiny façade whose `Type` builders
 * return Zod schemas. Output is indistinguishable from hand-written Zod inside
 * the agent pipeline:
 *
 *   - `isZodSchema()` keys off the Zod `_zod` marker that every schema carries.
 *   - `zodToWireSchema()` emits the same draft 2020-12 JSON Schema providers expect
 *     from TypeBox-authored tools (defaulted fields treated as optional, etc.).
 *
 * The surface intentionally covers only the common TypeBox builders. Plugins
 * that reached for niche TypeBox-only APIs (`TypeCompiler`, the global
 * `TypeRegistry`, custom `Symbol(TypeBox.Kind)` introspection) must vendor
 * `@sinclair/typebox` directly in their own package.
 */

import { areJsonValuesEqual } from "@oh-my-pi/pi-ai/utils/schema";
import {
	type ZodArray,
	type ZodEnum,
	type ZodObject,
	type ZodOptional,
	type ZodRawShape,
	type ZodType,
	z,
} from "zod/v4";

// ---------------------------------------------------------------------------
// Type aliases — exported so `import type { Static, TSchema } from "..."`
// patterns keep compiling at the call site.
// 类型别名 —— 导出后让调用方 `import type { Static, TSchema } from "..."`
// 的写法仍然可以通过类型检查。
// ---------------------------------------------------------------------------

/** 任意 schema 类型，对应 typebox 的 TSchema */
export type TSchema = ZodType;
/** 从 schema 推导静态 TS 类型，等价于 typebox 的 Static<T> */
export type Static<T extends ZodType> = z.infer<T>;
/** 任意值 schema 别名 */
export type TAny = ZodType;
/** unknown schema 别名 */
export type TUnknown = ZodType;
/** never schema 别名 */
export type TNever = ZodType;
/** null schema 别名 */
export type TNull = ZodType;
/** 字符串 schema 别名 */
export type TString = z.ZodString;
/** 数值 schema 别名 */
export type TNumber = z.ZodNumber;
/** 整数 schema 别名 */
export type TInteger = z.ZodNumber;
/** 布尔 schema 别名 */
export type TBoolean = z.ZodBoolean;
/** 字面量 schema 别名 */
export type TLiteral<V extends string | number | boolean> = z.ZodLiteral<V>;
/** 数组 schema 别名 */
export type TArray<E extends ZodType> = ZodArray<E>;
/** 对象 schema 别名 */
export type TObject<P extends ZodRawShape = ZodRawShape> = ZodObject<P>;
/** 可选 schema 别名 */
export type TOptional<E extends ZodType> = ZodOptional<E>;
/** 联合 schema 别名 */
export type TUnion<_T extends readonly ZodType[] = readonly ZodType[]> = ZodType;
/** 枚举 schema 别名（字面量联合） */
export type TEnum<T extends readonly (string | number)[] = readonly (string | number)[]> = ZodEnum<{
	[K in T[number] as `${K}`]: K;
}>;
/** record schema 别名 */
export type TRecord<_K extends ZodType, _V extends ZodType> = ZodType;

// ---------------------------------------------------------------------------
// Option shapes — loose subset of JSON Schema metadata + per-type constraints.
// 选项类型 —— JSON Schema metadata 的宽松子集 + 各类型特有的约束。
// ---------------------------------------------------------------------------

/** 通用 schema 元信息（title / description / default 等） */
interface Meta {
	title?: string;
	description?: string;
	default?: unknown;
	examples?: unknown[];
	// Real TypeBox accepts arbitrary extra JSON Schema keywords; we tolerate
	// them silently so callers don't blow up on niche metadata.
	// 真正的 TypeBox 允许任意额外的 JSON Schema 关键字，这里也默默接受，
	// 以避免冷门 metadata 让调用方报错。
	[key: string]: unknown;
}

/** 字符串 schema 选项 */
interface StringOpts extends Meta {
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	format?: string;
}

/** 数值 schema 选项 */
interface NumberOpts extends Meta {
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
}

/** 数组 schema 选项 */
interface ArrayOpts extends Meta {
	minItems?: number;
	maxItems?: number;
	uniqueItems?: boolean;
}

/** 对象 schema 选项 */
interface ObjectOpts extends Meta {
	/**
	 * TypeBox default: extra keys are preserved. Set `false` to reject unknowns,
	 * `true` to allow any, or a schema to validate them.
	 *
	 * TypeBox 默认会保留额外字段；设为 `false` 拒绝未知字段，`true` 接受
	 * 任意字段，或传入一个 schema 用于校验。
	 */
	additionalProperties?: boolean | ZodType;
}

// ---------------------------------------------------------------------------
// Helpers 辅助函数
// ---------------------------------------------------------------------------

/** 把 Meta 中的 description / default / 其他自定义字段挂回到 schema 上 */
function withMeta<T extends ZodType>(schema: T, opts: Meta | undefined): T {
	if (!opts) return schema;
	let out: ZodType = schema;
	if (typeof opts.description === "string") out = out.describe(opts.description);
	if ("default" in opts) out = out.default(opts.default as never) as unknown as ZodType;

	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(opts)) {
		if (key === "description" || key === "default" || key === "additionalProperties") continue;
		metadata[key] = value;
	}
	if (Object.keys(metadata).length > 0) out = out.meta(metadata);
	return out as T;
}

// ---------------------------------------------------------------------------
// Builders Schema 构造器
// ---------------------------------------------------------------------------

/** 构造字符串 schema，支持 format / length / pattern 等约束 */
function tString(opts?: StringOpts): ZodType {
	let s: ZodType = z.string();
	if (opts) {
		// Format selection swaps the base schema for a more specific Zod string
		// validator that emits the right `format` keyword in JSON Schema.
		// 根据 format 切换为更精确的 Zod 字符串校验器，
		// 这样导出的 JSON Schema 才会带正确的 `format` 关键字。
		switch (opts.format) {
			case "email":
				s = z.email();
				break;
			case "url":
			case "uri":
				s = z.url();
				break;
			case "uuid":
				s = z.uuid();
				break;
			case "date-time":
				s = z.iso.datetime();
				break;
			case "date":
				s = z.iso.date();
				break;
			case "time":
				s = z.iso.time();
				break;
			case "ipv4":
				s = z.ipv4();
				break;
			case "ipv6":
				s = z.ipv6();
				break;
			default:
				break;
		}
		// Length/pattern constraints live on the `_ZodString` base that every
		// format-specific schema (ZodEmail, ZodURL, ZodISODateTime, ...) extends,
		// so we apply them regardless of which concrete subclass `s` ended up as.
		// 长度 / pattern 约束位于 `_ZodString` 基类上，所有 format 特化
		// schema（ZodEmail / ZodURL / ZodISODateTime 等）都继承了它，
		// 因此无论 `s` 最终是哪个子类都可以照常应用。
		const sf = s as z.ZodString;
		if (typeof opts.minLength === "number") s = sf.min(opts.minLength);
		if (typeof opts.maxLength === "number") s = (s as z.ZodString).max(opts.maxLength);
		if (typeof opts.pattern === "string") s = (s as z.ZodString).regex(new RegExp(opts.pattern));
	}
	return withMeta(s, opts);
}

/** 将 NumberOpts 中的范围 / 倍数等约束应用到 ZodNumber 上 */
function applyNumberConstraints(base: z.ZodNumber, opts: NumberOpts | undefined): z.ZodNumber {
	if (!opts) return base;
	let out = base;
	if (typeof opts.minimum === "number") out = out.min(opts.minimum);
	if (typeof opts.maximum === "number") out = out.max(opts.maximum);
	if (typeof opts.exclusiveMinimum === "number") out = out.gt(opts.exclusiveMinimum);
	if (typeof opts.exclusiveMaximum === "number") out = out.lt(opts.exclusiveMaximum);
	if (typeof opts.multipleOf === "number") out = out.multipleOf(opts.multipleOf);
	return out;
}

/** 构造数值 schema */
function tNumber(opts?: NumberOpts): ZodType {
	return withMeta(applyNumberConstraints(z.number(), opts), opts);
}

/** 构造整数 schema */
function tInteger(opts?: NumberOpts): ZodType {
	return withMeta(applyNumberConstraints(z.number().int(), opts), opts);
}

/** 构造布尔 schema */
function tBoolean(opts?: Meta): ZodType {
	return withMeta(z.boolean(), opts);
}

/** 构造 null schema */
function tNull(opts?: Meta): ZodType {
	return withMeta(z.null(), opts);
}

/** 构造 any schema */
function tAny(opts?: Meta): ZodType {
	return withMeta(z.any(), opts);
}

/** 构造 unknown schema */
function tUnknown(opts?: Meta): ZodType {
	return withMeta(z.unknown(), opts);
}

/** 构造 never schema */
function tNever(opts?: Meta): ZodType {
	return withMeta(z.never(), opts);
}

/** 构造字面量 schema */
function tLiteral<V extends string | number | boolean>(value: V, opts?: Meta): ZodType {
	return withMeta(z.literal(value), opts);
}

/** 构造联合 schema；空数组退化为 never，单元素退化为该 schema 自身 */
function tUnion<T extends readonly ZodType[]>(schemas: T, opts?: Meta): ZodType {
	if (schemas.length === 0) return withMeta(z.never(), opts);
	if (schemas.length === 1) return withMeta(schemas[0] as ZodType, opts);
	return withMeta(z.union(schemas as unknown as [ZodType, ZodType, ...ZodType[]]), opts);
}

/** 构造交集 schema；空数组退化为 unknown，单元素退化为该 schema 自身 */
function tIntersect(schemas: readonly ZodType[], opts?: Meta): ZodType {
	if (schemas.length === 0) return withMeta(z.unknown(), opts);
	if (schemas.length === 1) return withMeta(schemas[0] as ZodType, opts);
	let out: ZodType = schemas[0] as ZodType;
	for (let i = 1; i < schemas.length; i++) out = z.intersection(out, schemas[i] as ZodType) as ZodType;
	return withMeta(out, opts);
}

/** 判断字符串 key 是否形如数组下标（"0"、"1"、"42" 等） */
function isArrayIndexKey(key: string): boolean {
	if (!/^(?:0|[1-9]\\d*)$/.test(key)) return false;
	const index = Number(key);
	return Number.isSafeInteger(index) && index >= 0;
}

/** 在保持顺序的前提下，对字面量数组做去重 */
function uniqueLiteralValues(values: readonly (string | number | boolean)[]): Array<string | number | boolean> {
	const unique: Array<string | number | boolean> = [];
	for (const value of values) {
		if (!unique.some(existing => existing === value)) unique.push(value);
	}
	return unique;
}

/** 把字面量数组转换为字面量联合 schema */
function literalUnion(values: readonly (string | number | boolean)[], opts?: Meta): ZodType {
	const unique = uniqueLiteralValues(values);
	if (unique.length === 0) return withMeta(z.never(), opts);
	if (unique.length === 1) return withMeta(z.literal(unique[0] as string | number | boolean), opts);
	const schemas = unique.map(value => z.literal(value as string | number | boolean)) as unknown as [
		ZodType,
		ZodType,
		...ZodType[],
	];
	return withMeta(z.union(schemas), opts);
}
/**
 * 构造枚举 schema：支持原生 TS enum（对象）与字面量数组两种形式。
 * 数值 enum 在编译后会同时出现反向映射（数字->字符串），这里通过
 * `isArrayIndexKey` 过滤掉反向映射条目。
 */
function tEnum<T extends Record<string, string | number> | readonly (string | number)[]>(
	values: T,
	opts?: Meta,
): ZodType {
	const list = Array.isArray(values)
		? values
		: Object.entries(values)
				.filter(([key, value]) => !(isArrayIndexKey(key) && typeof value === "string"))
				.map(([, value]) => value);
	return literalUnion(list, opts);
}

/** 构造数组 schema，支持 minItems / maxItems / uniqueItems 约束 */
function tArray<E extends ZodType>(item: E, opts?: ArrayOpts): ZodType {
	let arr: ZodType = z.array(item);
	if (opts) {
		if (typeof opts.minItems === "number") arr = (arr as ZodArray<E>).min(opts.minItems);
		if (typeof opts.maxItems === "number") arr = (arr as ZodArray<E>).max(opts.maxItems);
		if (opts.uniqueItems === true) {
			arr = arr.refine(items => {
				if (!Array.isArray(items)) return true;
				for (let i = 0; i < items.length; i += 1) {
					for (let j = i + 1; j < items.length; j += 1) {
						if (areJsonValuesEqual(items[i], items[j])) return false;
					}
				}
				return true;
			}, "Expected array items to be unique");
		}
	}
	return withMeta(arr, opts);
}

/** 构造定长元组 schema */
function tTuple(items: readonly ZodType[], opts?: Meta): ZodType {
	return withMeta(z.tuple(items as unknown as [ZodType, ...ZodType[]]) as unknown as ZodType, opts);
}

/** 判断给定 schema 是否已经是 optional 包装 */
function isOptional(schema: ZodType): boolean {
	const def = (schema as { _zod?: { def?: { type?: string } } })._zod?.def;
	return def?.type === "optional";
}

/** 构造对象 schema，支持通过 additionalProperties 控制对未知字段的行为 */
function tObject<P extends ZodRawShape>(properties: P, opts?: ObjectOpts): ZodObject<P> {
	// `z.object` automatically derives `required` from non-optional entries,
	// so `Type.Optional(...)` flows through unchanged (Zod treats `.optional()`
	// and `Type.Optional`-style wrappers identically).
	// `z.object` 会自动从非 optional 字段推导 required，因此 `Type.Optional(...)`
	// 可以原样透传（Zod 中的 `.optional()` 与 typebox 的 Optional 行为一致）。
	let obj = z.object(properties);
	const ap = opts?.additionalProperties;
	if (ap === false) {
		obj = obj.strict() as unknown as ZodObject<P>;
	} else if (ap === undefined || ap === true) {
		// TypeBox preserves unknown keys by default; Zod's default is `.strip()`.
		// TypeBox 默认保留未知字段，而 Zod 默认是 `.strip()`，这里改用 loose
		obj = obj.loose() as unknown as ZodObject<P>;
	} else {
		obj = obj.catchall(ap) as unknown as ZodObject<P>;
	}
	return withMeta(obj, opts);
}

/** 构造 record schema（任意 key -> value） */
function tRecord<V extends ZodType>(key: ZodType, value: V, opts?: Meta): ZodType {
	return withMeta(z.record(key as never, value as never) as unknown as ZodType, opts);
}

/** 把 schema 包装为 optional；若已为 optional 则直接返回 */
function tOptional<E extends ZodType>(schema: E, _opts?: Meta): ZodOptional<E> {
	return isOptional(schema) ? (schema as unknown as ZodOptional<E>) : (schema.optional() as ZodOptional<E>);
}

/** 把 schema 包装为可空（nullable） */
function tNullable<E extends ZodType>(schema: E, opts?: Meta): ZodType {
	return withMeta(schema.nullable() as ZodType, opts);
}

/** Readonly 在 TypeBox 中只是标记，运行时解析行为不变，这里直接返回原 schema */
function tReadonly<E extends ZodType>(schema: E): E {
	// TypeBox's `Type.Readonly` is purely a marker; runtime parsing is identical.
	return schema;
}

/** 将对象 schema 的所有字段变为可选 */
function tPartial<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return obj.partial() as unknown as ZodObject<P>;
}

/** 将对象 schema 的所有字段变为必填 */
function tRequired<P extends ZodRawShape>(obj: ZodObject<P>): ZodObject<P> {
	return obj.required() as unknown as ZodObject<P>;
}

/** 从对象 schema 中挑选指定字段 */
function tPick<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Pick<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return obj.pick(mask as never) as unknown as ZodObject<Pick<P, K>>;
}

/** 从对象 schema 中排除指定字段 */
function tOmit<P extends ZodRawShape, K extends keyof P>(obj: ZodObject<P>, keys: readonly K[]): ZodObject<Omit<P, K>> {
	const mask = Object.fromEntries(keys.map(k => [k as string, true]));
	return obj.omit(mask as never) as unknown as ZodObject<Omit<P, K>>;
}

/**
 * `Type.Composite([...])` 会把多个对象 schema 扁平合并为一个对象，
 * 而不是生成交集（intersection）。这里用连续 `extend` 来模拟该行为。
 */
function tComposite(objects: readonly ZodObject<ZodRawShape>[], opts?: Meta): ZodObject<ZodRawShape> {
	// `Type.Composite([...])` flattens every object schema into one object schema
	// rather than producing an intersection. Mirror that via repeated `extend`.
	if (objects.length === 0) return withMeta(z.object({}), opts) as ZodObject<ZodRawShape>;
	let out = objects[0] as ZodObject<ZodRawShape>;
	for (let i = 1; i < objects.length; i += 1) {
		out = out.extend(objects[i].shape) as ZodObject<ZodRawShape>;
	}
	return withMeta(out, opts) as ZodObject<ZodRawShape>;
}

// ---------------------------------------------------------------------------
// Public `Type` namespace  对外暴露的 `Type` 命名空间
// ---------------------------------------------------------------------------

/** TypeBox 兼容的 `Type` 构造器集合（底层由 Zod 实现） */
export const Type = {
	String: tString,
	Number: tNumber,
	Integer: tInteger,
	Boolean: tBoolean,
	Null: tNull,
	Any: tAny,
	Unknown: tUnknown,
	Never: tNever,
	Literal: tLiteral,
	Union: tUnion,
	Intersect: tIntersect,
	Enum: tEnum,
	Array: tArray,
	Tuple: tTuple,
	Object: tObject,
	Record: tRecord,
	Optional: tOptional,
	Nullable: tNullable,
	Readonly: tReadonly,
	Partial: tPartial,
	Required: tRequired,
	Pick: tPick,
	Omit: tOmit,
	Composite: tComposite,
} as const;

/** `Type` 构造器命名空间的类型 */
export type TypeBuilder = typeof Type;

/**
 * Default namespace export so `import * as typebox from "./typebox"` still resolves the `Type` key.
 *
 * 默认导出一个含 `Type` 字段的命名空间，确保
 * `import * as typebox from "./typebox"` 之类的写法仍可访问到 `Type`。
 */
export default { Type };

