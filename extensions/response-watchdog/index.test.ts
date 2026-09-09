import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerResponseWatchdog } from "./index.ts";

test("native session retries a stalled response without repeating a completed tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pipi-response-retry-"));
  const faux = fauxProvider({ models: [{ id: "one" }, { id: "two" }] });
  await writeFile(
    path.join(directory, "models.json"),
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: "https://fixture.invalid" } },
    }),
  );
  const installed: unknown[] = [];
  let executions = 0;
  faux.setResponses([
    fauxAssistantMessage(
      [{ type: "toolCall", id: "once", name: "increment", arguments: {} }],
      { stopReason: "toolUse" },
    ),
    () => new Promise(() => {}),
    fauxAssistantMessage("finished"),
  ]);
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    extensionFactories: [
      (pi) => {
        pi.registerProvider(faux.provider);
        registerResponseWatchdog(pi, 50);
        const observe = (
          _event: unknown,
          ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
        ) => {
          const native =
            ctx.modelRegistry.getRegisteredNativeProvider("openai-codex");
          assert.ok(
            native,
            "built-in provider must receive the watchdog on initial load",
          );
          installed.push(native);
        };
        pi.on("session_start", observe);
        pi.on("model_select", observe);
        pi.registerTool({
          name: "increment",
          label: "Increment",
          description: "Fixture",
          parameters: Type.Object({}),
          async execute() {
            executions++;
            return {
              content: [{ type: "text", text: "recorded" }],
              details: {},
            };
          },
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: faux.getModel(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
  });
  const retries: number[] = [];
  session.subscribe((event) => {
    if (event.type === "auto_retry_start") retries.push(event.attempt);
  });
  try {
    await session.bindExtensions({ mode: "print" });
    const secondModel = faux.getModel("two");
    assert.ok(secondModel);
    await session.setModel(secondModel);
    assert.ok(installed.length >= 2);
    assert.equal(
      new Set(installed).size,
      1,
      "configured providers must not acquire nested watchdogs on model selection",
    );
    await session.prompt("Perform the fixture task");
    assert.equal(executions, 1);
    assert.equal(faux.state.callCount, 3);
    assert.deepEqual(retries, [1]);
    assert.equal(session.messages.at(-1)?.role, "assistant");
    assert.equal(session.isStreaming, false);
    const before = faux.state.callCount;
    retries.length = 0;
    faux.setResponses(
      Array.from({ length: 3 }, () => () => new Promise(() => {})),
    );
    await session.prompt("Remain stalled to verify the retry budget");
    assert.equal(faux.state.callCount - before, 3);
    assert.deepEqual(retries, [1, 2]);
    assert.equal(executions, 1);
    assert.equal(session.isStreaming, false);
  } finally {
    await session.abort();
    session.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
