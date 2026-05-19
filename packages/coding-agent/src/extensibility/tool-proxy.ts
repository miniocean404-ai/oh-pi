
/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 *
 * 在 wrapper 对象上定义惰性代理属性，使其转发到底层 tool 对象。
 * 遍历 tool 的原型链，将每个属性以 getter 形式暴露到 wrapper：
 * - 函数类型自动 bind 到 tool，保证 this 指向正确
 * - 非函数类型直接返回当前值
 * - 已存在于 wrapper 上的属性优先保留（不覆盖）
 */
export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	// 沿原型链逐层向上遍历，直到 Object.prototype
	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			// 跳过 constructor、已处理的 key、以及 wrapper 已经拥有的属性
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					// 函数需要绑定到原 tool，否则方法内的 this 会指向 wrapper
					return typeof value === "function" ? value.bind(tool) : value;
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}

