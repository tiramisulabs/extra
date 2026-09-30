import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import type { LabClient } from './bridge';
import { HostClient } from './HostClient';
import './style.css';

// `?fixture` renders synthetic data without a host; it is loaded on demand to keep it out of the main chunk.
const client: Promise<LabClient> = new URLSearchParams(location.search).has('fixture')
	? import('./dev/FixtureClient').then(module => new module.FixtureClient())
	: Promise.resolve(new HostClient());
const root = document.getElementById('root');
if (root) void client.then(value => createRoot(root).render(<App client={value} />));
