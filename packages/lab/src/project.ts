import type { Project, Scenario } from './index';
import { type ProjectDescription, validateProjectDescription } from './protocol';

/** Shared preparation is always first; its ID cannot be shadowed by an extension. */
export function projectScenarios<R>(project: Project<R>): Scenario<R>[] {
	const scenarios = project.scenarios ?? [];
	const setup = project.setup;
	if (!setup) return scenarios;
	if (scenarios.some(scenario => scenario.id === setup.id))
		throw new Error(`Scenario "${setup.id}" conflicts with the shared setup`);
	return [setup, ...scenarios];
}

/** Descriptions include inherited parameters so every client launches the same preparation. */
export function describeProject<R>(project: Project<R>): ProjectDescription {
	const description: ProjectDescription = {
		name: project.name,
		...(project.setup ? { setup: { id: project.setup.id, version: project.setup.version } } : {}),
		scenarios: projectScenarios(project).map(({ id, version, title, params }) => ({
			id,
			version,
			title,
			params: { ...project.setup?.params, ...params },
		})),
		services: Object.fromEntries(
			Object.entries(project.services ?? {}).map(([name, service]) => [
				name,
				{ default: service.default, variants: Object.keys(service.variants) },
			]),
		),
		inspectors: Object.keys(project.inspect ?? {}),
	};
	validateProjectDescription(description);
	return description;
}
