// server.ts: what it keeps from Zigbee2MQTT's messages, each tool against a recording publish, and the server
// itself started over stdio with no broker to reach. Nothing here talks to a real MQTT broker.
import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { zigbee, onMessage, callTool, unreachable, topics, TOOLS, type Zigbee } from "../server";

const SERVER = path.join(import.meta.dir, "..", "server.ts");
const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

function online(): { z: Zigbee; sent: { topic: string; payload: unknown }[] } {
  const sent: { topic: string; payload: unknown }[] = [];
  const z = zigbee("zigbee2mqtt", "mqtt://localhost:1883", async (topic, payload) => { sent.push({ topic, payload }); }, () => true);
  onMessage(z, "zigbee2mqtt/bridge/state", '{"state":"online"}');
  return { z, sent };
}

test("subscribes to the device list, the bridge's state and every device", () => {
  assert.deepEqual(topics("z2m"), ["z2m/bridge/devices", "z2m/bridge/state", "z2m/+"]);
});

test("keeps the device list, the bridge's state in both forms, and each device's state", () => {
  const { z } = online();
  onMessage(z, "zigbee2mqtt/bridge/devices", JSON.stringify([{ friendly_name: "Coordinator", type: "Coordinator" }, { friendly_name: "light2", type: "Router" }]));
  assert.deepEqual([...z.devices.keys()], ["Coordinator", "light2"]);
  onMessage(z, "zigbee2mqtt/light2", '{"state":"ON","brightness":200}');
  assert.deepEqual(z.states.get("light2"), { state: "ON", brightness: 200 });
  onMessage(z, "zigbee2mqtt/bridge/state", "offline");
  assert.equal(z.bridge, "offline");
  onMessage(z, "zigbee2mqtt/bridge/state", '{"state":"online"}');
  assert.equal(z.bridge, "online");
  onMessage(z, "zigbee2mqtt/bridge/devices", "not json");
  assert.equal(z.devices.size, 2, "a torn device list keeps the last good one");
  onMessage(z, "zigbee2mqtt/light2/set", '{"state":"OFF"}');
  assert.deepEqual(z.states.get("light2"), { state: "ON", brightness: 200 }, "only <base>/<device> is a state");
});

test("set publishes everything but the name to <base>/<name>/set", async () => {
  const { z, sent } = online();
  const r = await callTool(z, "set", { name: "light2", state: "ON", color: { r: 255, g: 0, b: 0 } });
  assert.equal(r.isError, undefined);
  assert.deepEqual(sent, [{ topic: "zigbee2mqtt/light2/set", payload: { state: "ON", color: { r: 255, g: 0, b: 0 } } }]);
  assert.match(text(r), /^Sent to light2/);
  assert.equal(text(await callTool(z, "set", { state: "OFF" })), "name is required");
});

test("nothing is sent while the broker is down or Zigbee2MQTT is offline or silent, and the reason comes back", async () => {
  const sent: unknown[] = [];
  let up = false;
  const z = zigbee("zigbee2mqtt", "mqtt://localhost:1883", async (_t, p) => { sent.push(p); }, () => up);
  const r = await callTool(z, "set", { name: "light2", state: "ON" });
  assert.equal(r.isError, true);
  assert.equal(text(r), "Not sent: not connected to the MQTT broker at mqtt://localhost:1883");
  up = true;
  assert.equal(unreachable(z), "Zigbee2MQTT isn't running (nothing on zigbee2mqtt/bridge/state)");
  onMessage(z, "zigbee2mqtt/bridge/state", '{"state":"offline"}');
  assert.equal(text(await callTool(z, "permit_join", {})), "Not sent: Zigbee2MQTT is offline");
  assert.equal(sent.length, 0);
});

test("permit_join, rename_device and remove_device send Zigbee2MQTT's bridge requests", async () => {
  const { z, sent } = online();
  assert.equal(text(await callTool(z, "permit_join", {})), "Permit join enabled for 254s");
  await callTool(z, "permit_join", { seconds: 60 });
  await callTool(z, "rename_device", { from: "0x00124b", to: "light3" });
  await callTool(z, "remove_device", { name: "light1" });
  await callTool(z, "remove_device", { name: "light1", force: true });
  assert.deepEqual(sent, [
    { topic: "zigbee2mqtt/bridge/request/permit_join", payload: { time: 254 } },
    { topic: "zigbee2mqtt/bridge/request/permit_join", payload: { time: 60 } },
    { topic: "zigbee2mqtt/bridge/request/device/rename", payload: { from: "0x00124b", to: "light3" } },
    { topic: "zigbee2mqtt/bridge/request/device/remove", payload: { id: "light1", force: false } },
    { topic: "zigbee2mqtt/bridge/request/device/remove", payload: { id: "light1", force: true } },
  ]);
});

test("list_devices leaves out the coordinator, and says why when it knows of none", async () => {
  const { z } = online();
  onMessage(z, "zigbee2mqtt/bridge/devices", JSON.stringify([
    { friendly_name: "Coordinator", type: "Coordinator" },
    { friendly_name: "light2", type: "Router", ieee_address: "0x01", definition: { model: "ZB-RGBCW", vendor: "Lonsonho", description: "Downlight" } },
  ]));
  onMessage(z, "zigbee2mqtt/light2", '{"state":"OFF"}');
  const list = JSON.parse(text(await callTool(z, "list_devices")));
  assert.deepEqual(list, [{ friendly_name: "light2", ieee_address: "0x01", model: "ZB-RGBCW", vendor: "Lonsonho", description: "Downlight", state: { state: "OFF" } }]);

  const down = zigbee("zigbee2mqtt", "mqtt://localhost:1883", async () => {}, () => true);
  const r = await callTool(down, "list_devices");
  assert.equal(r.isError, true);
  assert.equal(text(r), "No devices known: Zigbee2MQTT isn't running (nothing on zigbee2mqtt/bridge/state)");
});

test("get_state and status answer from what Zigbee2MQTT last said", async () => {
  const { z } = online();
  onMessage(z, "zigbee2mqtt/bridge/devices", JSON.stringify([{ friendly_name: "Coordinator", type: "Coordinator" }, { friendly_name: "light2" }]));
  onMessage(z, "zigbee2mqtt/light2", '{"state":"ON"}');
  assert.deepEqual(JSON.parse(text(await callTool(z, "get_state", { name: "light2" }))), { state: "ON" });
  const none = await callTool(z, "get_state", { name: "light9" });
  assert.equal(none.isError, true);
  assert.equal(text(none), "No state for light9");
  assert.deepEqual(JSON.parse(text(await callTool(z, "status"))), { broker: "mqtt://localhost:1883", connected: true, zigbee2mqtt: "online", devices: 1 });
});

test("an unknown tool and a failed publish come back as errors", async () => {
  const z = zigbee("zigbee2mqtt", "mqtt://localhost:1883", async () => { throw new Error("connection closed"); }, () => true);
  onMessage(z, "zigbee2mqtt/bridge/state", "online");
  assert.equal(text(await callTool(z, "dance")), "Unknown tool: dance");
  const r = await callTool(z, "set", { name: "light2", state: "OFF" });
  assert.equal(r.isError, true);
  assert.equal(text(r), "Error: connection closed");
});

test("the server starts on bun, lists its tools over stdio, and refuses a set with no broker", async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v;
  env.MQTT_URL = "mqtt://127.0.0.1:1";   // nothing listens there
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" });
  const client = new Client({ name: "zigbee-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name), TOOLS.map(t => t.name));
    const r = await client.callTool({ name: "set", arguments: { name: "light2", state: "ON" } }) as CallToolResult;
    assert.equal(r.isError, true);
    assert.equal(text(r), "Not sent: not connected to the MQTT broker at mqtt://127.0.0.1:1");
  } finally { await client.close(); }
});
