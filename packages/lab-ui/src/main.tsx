import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import type { LabClient } from './bridge';
import { FixtureClient } from './dev/FixtureClient';
import { HostClient } from './HostClient';
import './style.css';

declare global {
	interface Window {
		labClient?: LabClient;
	}
}

const client = new URLSearchParams(location.search).has('fixture') ? new FixtureClient() : new HostClient();
const root = document.getElementById('root');
if (root)
	createRoot(root).render(
		client ? (
			<App client={client} />
		) : (
			<main className="connection-screen">
				<h1>Seyfert Lab</h1>
				<p>Open this page from the lab host.</p>
			</main>
		),
	);
