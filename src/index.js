// Entry point for all Forge functions declared in manifest.yml.

// Rovo action from the starter template (kept for now as a smoke test).
export function messageLogger(payload) {
  console.log(`Logging message: ${payload.message}`);
}

// Resolver for the Premise byline panel (frontend calls it with invoke()).
export { handler, scheduledCheck, bylineProps } from './resolvers';

// Teamwork Graph connector: admin connects or disconnects it.
export { onConnectionChange } from './connector';
