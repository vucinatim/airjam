import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import {
  renderMcpClientProfile,
  writeProjectLocalMcpConfig,
} from "../dist/config.js";
import {
  createAirJamMcpServer,
  inspectMcpProjectSetup,
} from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageVersion = JSON.parse(
  await readFile(path.resolve(__dirname, "../package.json"), "utf8"),
).version;
const tempRoots: string[] = [];

const createTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airjam-mcp-server-"));
  tempRoots.push(root);
  return root;
};

const createStandaloneGameRoot = async (): Promise<string> => {
  const root = await createTempRoot();
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "standalone-airjam-fixture",
        private: true,
        dependencies: {
          "@air-jam/sdk": "^1.0.0",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(root, "src", "airjam.config.ts"),
    "export const airjam = { controllerPath: '/controller' };\n",
    "utf8",
  );
  return root;
};

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reports the installed MCP package version", () => {
  const output = execFileSync(
    process.execPath,
    [path.resolve(__dirname, "../dist/cli.js"), "--version"],
    { cwd: path.resolve(__dirname, ".."), encoding: "utf8" },
  );
  expect(output.trim()).toBe(packageVersion);
});

it("ships every devtools helper used by the bundled MCP server", async () => {
  for (const name of [
    "agent-contract",
    "hold-runtime-host",
    "inspect-airjam-agent",
    "list-visual-scenarios",
    "run-visual-capture",
  ]) {
    await expect(
      access(path.resolve(__dirname, `../dist/tooling/${name}.js`)),
    ).resolves.toBeUndefined();
  }
});

describe("createAirJamMcpServer", () => {
  it("registers the core Air Jam tools", async () => {
    const server = await createAirJamMcpServer({
      cwd: path.resolve(__dirname, "../../.."),
    });
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    expect(client.getServerVersion()).toEqual({
      name: "air-jam",
      version: packageVersion,
    });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "airjam.inspect_project",
      "airjam.auth_status",
      "airjam.list_games",
      "airjam.inspect_game",
      "airjam.inspect_game_agent_contract",
      "airjam.read_logs",
      "airjam.run_quality_gate",
      "airjam.release_list",
      "airjam.release_inspect",
      "airjam.release_upload",
      "airjam.release_finalize",
      "airjam.release_export",
      "airjam.release_publish",
      "airjam.start_dev",
      "airjam.stop_dev",
      "airjam.status",
      "airjam.reset_local",
      "airjam.topology",
      "airjam.open_game_session",
      "airjam.send_game_session_input",
      "airjam.read_game_session",
      "airjam.invoke_game_session_action",
      "airjam.close_game_session",
    ]);

    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.inspect_project",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.auth_status",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("airjam.read_logs");
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_list",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_inspect",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_upload",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_finalize",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_export",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_publish",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.release_doctor",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.release_validate",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.release_bundle",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.release_submit",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain("airjam.start_dev");
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.reset_local",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.inspect_game_agent_contract",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.open_game_session",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.send_game_session_input",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.read_game_session",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.invoke_game_session_action",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.close_game_session",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.read_harness_snapshot",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.list_harness_sessions",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.connect_controller",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.read_runtime_snapshot",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.read_game_snapshot",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.invoke_game_action",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.list_visual_scenarios",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.capture_visuals",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.list_visual_capture_summaries",
    );
    expect(listed.tools.map((tool) => tool.name)).not.toContain(
      "airjam.read_visual_capture_summary",
    );
  });

  it("registers standalone release tools for standalone game projects", async () => {
    const root = await createStandaloneGameRoot();
    const server = await createAirJamMcpServer({ cwd: root });
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_doctor",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_validate",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_bundle",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_submit",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_upload",
    );
    expect(listed.tools.map((tool) => tool.name)).toContain(
      "airjam.release_finalize",
    );
    expect(
      listed.tools.find((tool) => tool.name === "airjam.release_bundle")
        ?.execution,
    ).toEqual({
      taskSupport: "required",
    });
    expect(
      listed.tools.find((tool) => tool.name === "airjam.release_submit")
        ?.execution,
    ).toEqual({
      taskSupport: "required",
    });
    expect(
      listed.tools.find((tool) => tool.name === "airjam.release_bundle")
        ?.description,
    ).toContain(
      "Requires an MCP client with task-backed tool execution support.",
    );
    expect(
      listed.tools.find((tool) => tool.name === "airjam.release_submit")
        ?.description,
    ).toContain(
      "Requires an MCP client with task-backed tool execution support.",
    );
  });

  it("runs inspect_project through MCP", async () => {
    const server = await createAirJamMcpServer();
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "airjam.inspect_project",
      arguments: {
        cwd: path.resolve(__dirname, "../../.."),
      },
    });

    expect(result.isError).not.toBe(true);
    const typedResult = result as {
      content: Array<{
        type: string;
        text?: string;
      }>;
    };
    const textBlock = typedResult.content.find(
      (block) => block.type === "text",
    );
    const parsed = JSON.parse(textBlock?.text ?? "{}");
    expect(parsed).toMatchObject({
      context: {
        mode: "monorepo",
      },
    });
  });

  it("exposes arcade-capable dev modes for monorepo game projects", async () => {
    const standaloneProjectRoot = path.resolve(
      __dirname,
      "../../../games/pong",
    );
    const server = await createAirJamMcpServer({
      cwd: standaloneProjectRoot,
    });
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    const startDevTool = listed.tools.find(
      (tool) => tool.name === "airjam.start_dev",
    );

    expect(startDevTool).toBeDefined();
    expect(JSON.stringify(startDevTool?.inputSchema ?? {})).toContain(
      "arcade-dev",
    );
  });

  it("only registers inspect_project outside recognized Air Jam projects", async () => {
    const root = await createTempRoot();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "not-air-jam", private: true }, null, 2),
      "utf8",
    );

    const server = await createAirJamMcpServer({ cwd: root });
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "airjam.inspect_project",
    ]);
  });
});

describe("inspectMcpProjectSetup", () => {
  it("reports the expected default config shape", async () => {
    const inspection = await inspectMcpProjectSetup({ cwd: process.cwd() });

    expect(inspection.recommendedConfig).toEqual({
      mcpServers: {
        airjam: {
          command: "pnpm",
          args: ["exec", "airjam-mcp"],
        },
      },
    });
  });

  it("renders one server declaration for portable, Codex, and Claude Desktop clients", async () => {
    const root = await createStandaloneGameRoot();
    const portable = renderMcpClientProfile({
      profile: "portable",
      projectDir: root,
    });
    const codex = renderMcpClientProfile({
      profile: "codex",
      projectDir: root,
    });
    const claudeDesktop = renderMcpClientProfile({
      profile: "claude-desktop",
      projectDir: root,
    });

    expect(JSON.parse(portable.content)).toEqual({
      mcpServers: {
        airjam: {
          command: "pnpm",
          args: ["exec", "airjam-mcp"],
        },
      },
    });
    expect(codex).toMatchObject({
      profile: "codex",
      format: "toml",
      scope: "project",
      configPath: path.join(root, ".codex", "config.toml"),
    });
    expect(codex.content).toContain("[mcp_servers.airjam]");
    expect(codex.content).toContain('command = "pnpm"');
    expect(codex.content).toContain('args = ["exec", "airjam-mcp"]');
    expect(codex.content).toContain(`cwd = "${root}"`);
    expect(JSON.parse(claudeDesktop.content)).toEqual(
      JSON.parse(portable.content),
    );
  });

  it("keeps the portable declaration separate from client registration state", async () => {
    const root = await createStandaloneGameRoot();
    await writeProjectLocalMcpConfig({ cwd: root });

    const inspection = await inspectMcpProjectSetup({ cwd: root });
    const canonicalRoot = await realpath(root);
    expect(inspection.portableDeclaration).toEqual({
      configPath: path.join(canonicalRoot, ".mcp.json"),
      present: true,
    });
    expect(inspection.clients.codex).toMatchObject({
      profile: "codex",
      configPath: path.join(canonicalRoot, ".codex", "config.toml"),
      configPresent: false,
      registered: false,
    });
  });
});
