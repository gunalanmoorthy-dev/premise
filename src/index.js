// Entry point for all Forge functions declared in manifest.yml.

// Rovo action from the starter template (kept for now as a smoke test).
export function messageLogger(payload) {
  console.log(`Logging message: ${payload.message}`);
}

// Resolver for the Premise byline panel (frontend calls it with invoke()).
export { handler } from './resolvers';
