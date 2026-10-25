#!/usr/bin/env bun
// zigbee-mcp: Zigbee2MQTT's devices as MCP tools. It listens to what Zigbee2MQTT says on MQTT (the device list,
// each device's state, and the bridge's own retained state) and turns tool calls into Zigbee2MQTT's requests.
// Run with `bun server.ts`. The tests drive callTool() and onMessage() with a recording publish, and start the
// server itself over stdio.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import mqtt from "mqtt";

export interface Device {
  friendly_name: string;
  ieee_address?: string;
  type?: string;
  definition?: { model?: string; vendor?: string; description?: string } | null;
}

/** What the server knows from MQTT, and how it sends. */
export interface Zigbee {
  baseTopic: string;
  /** the broker's URL, for messages */
  broker: string;
  devices: Map<string, Device>;
  states: Map<string, unknown>;
  /** Zigbee2MQTT's retained <base>/bridge/state ("online", "offline"), or null before it has said anything */
  bridge: string | null;
  connected(): boolean;
  publish(topic: string, payload: unknown): Promise<void>;
}

export function zigbee(baseTopic: string, broker: string, publish: Zigbee["publish"], connected: () => boolean): Zigbee {
  return { baseTopic, broker, devices: new Map(), states: new Map(), bridge: null, connected, publish };
}

export const topics = (base: string): string[] => [`${base}/bridge/devices`, `${base}/bridge/state`, `${base}/+`];

/** One MQTT message from Zigbee2MQTT: the device list, the bridge's state, or one device's state. */
export function onMessage(z: Zigbee, topic: string, msg: string): void {
  const base = z.baseTopic;
  if (topic === `${base}/bridge/devices`) {
    let list: Device[];
    try { list = JSON.parse(msg); } catch { return; }
    z.devices.clear();
    for (const d of list) z.devices.set(d.friendly_name, d);
    return;
  }
  if (topic === `${base}/bridge/state`) {
    // {"state":"online"} from Zigbee2MQTT 1.20 on, a bare online before that
    let s = msg.trim();
    try { const j = JSON.parse(s) as { state?: unknown }; if (j && typeof j.state === "string") s = j.state; } catch { /* the bare form */ }
    z.bridge = s || null;
    return;
  }
  const parts = topic.split("/");
  if (parts.length === 2 && parts[0] === base && parts[1] !== "bridge") {
    try { z.states.set(parts[1], JSON.parse(msg)); } catch { /* not a state */ }
  }
}

/** Why a request can't reach Zigbee2MQTT now, or null when it can. The broker takes a publish whether or not
 *  Zigbee2MQTT is listening, so without this a command with Zigbee2MQTT down would report success and do nothing. */
export function unreachable(z: Zigbee): string | null {
  if (!z.connected()) return `not connected to the MQTT broker at ${z.broker}`;
  if (z.bridge === "online") return null;
  if (z.bridge) return `Zigbee2MQTT is ${z.bridge}`;
  return `Zigbee2MQTT isn't running (nothing on ${z.baseTopic}/bridge/state)`;
}

export const TOOLS: Tool[] = [
  {
    name: "list_devices",
    description: "List all paired Zigbee devices with current state, model, and vendor",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set",
    description: "Control a Zigbee light. Provide any combination of state/brightness/color/color_temp/effect/transition.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Friendly name (e.g. 'light1') or 'all' to broadcast" },
        state: { type: "string", enum: ["ON", "OFF", "TOGGLE"] },
        brightness: { type: "number", minimum: 0, maximum: 254 },
        color: {
          type: "object",
          description: "RGB color, 0-255 per channel",
          properties: {
            r: { type: "number", minimum: 0, maximum: 255 },
            g: { type: "number", minimum: 0, maximum: 255 },
            b: { type: "number", minimum: 0, maximum: 255 },
          },
          required: ["r", "g", "b"],
        },
        color_temp: { type: "number", minimum: 150, maximum: 500, description: "Mireds: 150=coolest, 500=warmest" },
        effect: {
          type: "string",
          enum: ["blink", "breathe", "okay", "channel_change", "finish_effect", "stop_effect", "colorloop", "stop_colorloop"],
        },
        transition: { type: "number", minimum: 0, description: "Smooth transition in seconds" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_state",
    description: "Get the most recent reported state of a device",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "status",
    description: "Whether the MQTT broker is connected and Zigbee2MQTT is online, and how many devices it has paired",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "permit_join",
    description: "Enable Zigbee pairing mode",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 0, maximum: 254, description: "How long to allow joins (default 254)" } },
    },
  },
  {
    name: "rename_device",
    description: "Change a device's friendly name",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "remove_device",
    description: "Unpair a device from the network",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        force: { type: "boolean", description: "Force-remove even if the device doesn't respond (use for dead/unreachable devices)" },
      },
      required: ["name"],
    },
  },
];

const reply = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export async function callTool(z: Zigbee, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const base = z.baseTopic;
  try {
    if (name === "list_devices") {
      const out = [];
      for (const [fname, d] of z.devices) {
        if (d.type === "Coordinator") continue;
        out.push({
          friendly_name: fname,
          ieee_address: d.ieee_address,
          model: d.definition?.model,
          vendor: d.definition?.vendor,
          description: d.definition?.description,
          state: z.states.get(fname) ?? null,
        });
      }
      const why = out.length ? null : unreachable(z);
      return why ? fail(`No devices known: ${why}`) : reply(JSON.stringify(out, null, 2));
    }

    if (name === "get_state") {
      const s = z.states.get(String(args.name));
      if (s) return reply(JSON.stringify(s, null, 2));
      const why = unreachable(z);
      return fail(`No state for ${args.name}${why ? ` (${why})` : ""}`);
    }

    if (name === "status") {
      return reply(JSON.stringify({
        broker: z.broker, connected: z.connected(), zigbee2mqtt: z.bridge,
        devices: [...z.devices.values()].filter(d => d.type !== "Coordinator").length,
      }, null, 2));
    }

    if (!TOOLS.some(t => t.name === name)) return fail(`Unknown tool: ${name}`);
    if (name === "set" && !args.name) return fail("name is required");
    const why = unreachable(z);
    if (why) return fail(`Not sent: ${why}`);

    if (name === "set") {
      const { name: dev, ...rest } = args;
      await z.publish(`${base}/${dev}/set`, rest);
      return reply(`Sent to ${dev}: ${JSON.stringify(rest)}`);
    }
    if (name === "permit_join") {
      const time = args.seconds ?? 254;
      await z.publish(`${base}/bridge/request/permit_join`, { time });
      return reply(`Permit join enabled for ${time}s`);
    }
    if (name === "rename_device") {
      await z.publish(`${base}/bridge/request/device/rename`, { from: args.from, to: args.to });
      return reply(`Renamed ${args.from} → ${args.to}`);
    }
    // remove_device
    await z.publish(`${base}/bridge/request/device/remove`, { id: args.name, force: args.force ?? false });
    return reply(`Remove requested for ${args.name}`);
  } catch (e) {
    return fail(`Error: ${(e as Error).message}`);
  }
}

export function createServer(z: Zigbee): Server {
  const server = new Server({ name: "zigbee", version: "1.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async req => callTool(z, req.params.name, req.params.arguments ?? {}));
  return server;
}

if (import.meta.main) {
  const url = process.env.MQTT_URL || "mqtt://localhost:1883";
  const client = mqtt.connect(url, { reconnectPeriod: 2000 });
  // QoS 1, so the broker acknowledges each request
  const publish = (topic: string, payload: unknown): Promise<void> => new Promise((resolve, reject) =>
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, err => err ? reject(err) : resolve()));
  const z = zigbee(process.env.Z2M_BASE_TOPIC || "zigbee2mqtt", url, publish, () => client.connected);
  client.on("connect", () => client.subscribe(topics(z.baseTopic)));
  // the bridge's state comes again, retained, on the next connect
  client.on("close", () => { z.bridge = null; });
  client.on("message", (topic, buf) => onMessage(z, topic, buf.toString()));
  await createServer(z).connect(new StdioServerTransport());
}
