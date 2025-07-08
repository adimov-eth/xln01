/** RFC 8785-style canonical JSON (only what we need) */
export const canonical = (value: unknown): string => {
	const walk = (v: unknown, stack: unknown[]): unknown => {
		if (typeof v === 'bigint') {
			return v.toString();
		}
		if (v && typeof v === 'object') {
			if (Array.isArray(v)) {
				return v.map(item => walk(item, stack));
			}
			// prevent cycles
			if (stack.includes(v)) {
				return '[Circular]';
			}
			const newStack = [...stack, v];
			const obj = v as Record<string, unknown>;
			const keys = Object.keys(obj);
			// eslint-disable-next-line fp/no-mutating-methods
			const sortedKeys = [...keys].sort();
			return sortedKeys.reduce(
				(acc, k) => ({
					...acc,
					[k]: walk(obj[k], newStack),
				}),
				{} as Record<string, unknown>,
			);
		}
		return v;
	};
	return JSON.stringify(walk(value, []));
};
