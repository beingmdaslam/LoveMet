import { Client } from "pg";

/**
 * Hyperdrive owns connection pooling. Create a lightweight Client per request,
 * connect, run the callback, and always close the client before returning.
 * Never cache a Client or connection string across Worker invocations.
 */
export async function withDatabase(env, callback, ClientConstructor = Client) {
  const connectionString = env?.HYPERDRIVE?.connectionString;
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("Hyperdrive binding is not configured.");
  }

  const client = new ClientConstructor({ connectionString });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    return await callback(client);
  } finally {
    if (connected) await client.end();
  }
}
