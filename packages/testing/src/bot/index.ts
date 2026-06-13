/*
 * Mock-bot maintenance map:
 * - New stateful route: add a Routes descriptor, a defaults responder, any needed
 *   WorldState mutator/view, a regression test, and a README line.
 * - New dispatcher verb: add the payload builder, MockBot method, Actor method,
 *   DISPATCHER_VERBS entry, matrix row, and README example.
 * - New world entity: add the payload factory, MockWorld field, WorldBuilder
 *   registration, cache seeding, state view, read/write responders, and a test
 *   that asserts both cache and view behavior.
 * - Seyfert deep imports are accepted break points for this peer range. If Seyfert
 *   reorganizes them, consolidate into one local internals module then.
 * - README export drift: repeat the README identifier cross-check on any
 *   README-touching mock-bot change.
 */
export * from './bot';
export * from './constants';
export * from './gateway';
export * from './interactions';
export * from './payloads';
export * from './permissions';
export * from './rest';
export * from './routes';
export * from './state';
export * from './world';
