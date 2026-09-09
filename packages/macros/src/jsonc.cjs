function updateProperty(text, file, names, value) {
	const parsed = ts.parseJsonText(file, text);
	if (parsed.parseDiagnostics.length) throw new Error(`Invalid JSONC: ${file}`);
	let object = parsed.statements[0]?.expression;
	for (let index = 0; index < names.length; index++) {
		if (!object || !ts.isObjectLiteralExpression(object))
			throw new Error(`Expected an object at ${names.slice(0, index).join('.') || file}`);
		const name = names[index];
		const property = object.properties.find(item => ts.isPropertyAssignment(item) && item.name.text === name);
		if (property && index < names.length - 1) {
			object = property.initializer;
			continue;
		}
		let replacement = value;
		for (let nested = names.length - 1; nested > index; nested--) replacement = { [names[nested]]: replacement };
		const serialized = JSON.stringify(replacement, null, 2);
		if (property)
			return text.slice(0, property.initializer.getStart(parsed)) + serialized + text.slice(property.initializer.end);
		const last = object.properties.at(-1);
		const position = last?.end ?? object.getStart(parsed) + 1;
		return (
			text.slice(0, position) + `${last ? ',' : ''}\n  ${JSON.stringify(name)}: ${serialized}\n` + text.slice(position)
		);
	}
	return text;
}

const ts = require('typescript');
module.exports = { updateProperty };
