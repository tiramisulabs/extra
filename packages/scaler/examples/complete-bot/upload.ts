import { Client } from 'seyfert';

async function main() {
	const client = new Client();
	await client.start();
	await client.uploadCommands();
	await client.close();
}

void main();
