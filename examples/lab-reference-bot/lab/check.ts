import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createChildSession } from '@slipher/lab/child';
import { createSession } from '@slipher/lab/runtime';
import { observable, preset, submitRequest } from './flow.js';
import { project } from './project.js';

async function check() {
	const projectModule = fileURLToPath(new URL('./project.js', import.meta.url));
	const inProcess = createSession(project, preset());
	const child = createChildSession({ projectModule, preset: preset() });
	await inProcess.start();
	try {
		await child.start();
		try {
			const memberSupport = await inProcess.view('member', 'channel.support');
			const staffStaff = await inProcess.view('staff', 'channel.staff');
			assert.ok(!memberSupport.diagnostics.includes('no-view-channel'));
			assert.ok(!staffStaff.diagnostics.includes('no-view-channel'));
			const first = await submitRequest(inProcess, 'bug', 'Headless check');
			const second = await submitRequest(child, 'bug', 'Headless check');
			assert.equal(first.submit.summary, 'Request sent to staff.');
			assert.equal(second.submit.summary, first.submit.summary);
			const inProcessView = await observable(inProcess);
			const childView = await observable(child);
			assert.deepEqual(childView, inProcessView);
			assert.ok(inProcessView.memberSupport.some(message => message.content === 'Support topic: bug'));
			assert.ok(
				inProcessView.memberSupport.some(
					message => message.content === 'Request sent to staff.' && message.visibility === 'ephemeral',
				),
			);
			assert.deepEqual(inProcessView.memberStaff, []);
			assert.ok(inProcessView.memberStaffDiagnostics.includes('no-view-channel'));
			assert.ok(inProcessView.staffStaff.some(message => message?.includes('Headless check')));
			const requester = (await inProcess.log()).preset.refs?.['role.requester'];
			assert.ok(requester);
			assert.ok(inProcessView.roles.includes(requester));
			console.log('lab:check passed in-process and child sessions');
		} finally {
			await child.dispose();
		}
	} finally {
		await inProcess.dispose();
	}
}

await check();
