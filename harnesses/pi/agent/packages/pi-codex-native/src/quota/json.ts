export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };
/** JSON.parse owns syntax validation; consumers immediately validate their endpoint schema. */
export function parseJson(text: string): JsonValue {
	return JSON.parse(text) as JsonValue;
}
