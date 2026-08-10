// Shell highlighting only needs lightweight token boundaries.
export function shellSplit(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	const pushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		const next = input[index + 1];

		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\") {
			if (!quote) {
				escaping = true;
				continue;
			}
			if (quote === '"') {
				if (next && (next === "\\" || next === '"' || next === "$" || next === "`")) {
					escaping = true;
					continue;
				}
				current += char;
				continue;
			}
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (char === "&" && next === "&") {
			pushCurrent();
			tokens.push("&&");
			index += 1;
			continue;
		}
		if (char === "|" && next === "|") {
			pushCurrent();
			tokens.push("||");
			index += 1;
			continue;
		}
		if (char === "|" || char === ";") {
			pushCurrent();
			tokens.push(char);
			continue;
		}

		if (/\s/.test(char)) {
			pushCurrent();
			continue;
		}

		current += char;
	}

	pushCurrent();
	return tokens;
}
