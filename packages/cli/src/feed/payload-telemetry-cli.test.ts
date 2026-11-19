import { expect, test } from "bun:test";
import { ErrorCodes } from "@tinycloud/sdk-services";

const marker = "SYNTHETIC-PRIVATE-SQL-CLI-ERROR-CODE-88";
const session = {
  delegationHeader: { Authorization: "test-invocation" }, delegationCid: "test-cid",
  spaceId: "tinycloud:pkh:eip155:1:0x1234567890123456789012345678901234567890:applications",
  verificationMethod: "did:key:test", jwk: {},
};

test("the actual CLI error renderer and an ordinary subscriber do not echo private SQL failure data", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(`synthetic SQL payload failure ${marker}`, { status: 400 }),
  });
  try {
    const errorsPath = new URL("../output/errors.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, "--eval", `
      import { SQLService, ServiceContext } from '@tinycloud/sdk-services';
      import { cliErrorFromService, handleError } from ${JSON.stringify(errorsPath)};
      const context = new ServiceContext({
        invoke: () => ({ Authorization: 'test-invocation' }), hosts: [${JSON.stringify(server.url.href)}],
        session: ${JSON.stringify(session)}, retryPolicy: { maxAttempts: 1 },
      });
      context.on('service.error', event => process.stderr.write(JSON.stringify(event) + '\\n'));
      const service = new SQLService(); service.initialize(context);
      const result = await service.query('SELECT ?', [${JSON.stringify(marker)}], { redactErrors: true });
      if (result.ok) throw new Error('The private SQL failure was mislabeled as success');
      await handleError(cliErrorFromService(result.error));
    `], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(stderr).toContain(ErrorCodes.SQL_ERROR);
    expect(stdout + stderr).not.toContain(marker);
  } finally { server.stop(true); }
});
