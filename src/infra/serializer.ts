// Custom JSON serializer that handles BigInt and Map
export const serialize = (obj: unknown): string => {
	return JSON.stringify(obj, (_, value) => {
		if (typeof value === 'bigint') {
			return { __type: 'bigint', value: value.toString() };
		}
		if (value instanceof Map) {
			return { __type: 'Map', value: Array.from(value.entries()) };
		}
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return value;
	});
};

export const deserialize = (str: string): unknown => {
	return JSON.parse(str, (_, value: unknown) => {
		if (value && typeof value === 'object' && '__type' in value) {
			const typedValue = value as { __type: string; value: unknown };
			if (typedValue.__type === 'bigint' && typeof typedValue.value === 'string') {
				return BigInt(typedValue.value);
			}
			if (typedValue.__type === 'Map' && Array.isArray(typedValue.value)) {
				return new Map(typedValue.value as Array<[unknown, unknown]>);
			}
		}
		return value;
	});
};
