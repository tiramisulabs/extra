import { Client } from 'seyfert';

async function main() {
	const client = new Client();
	try {
		await client.start({}, false);
		await client.uploadCommands();
	} finally {
		await client.close();
	}
}

void main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
