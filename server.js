#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import mqtt from "mqtt";

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const BASE_TOPIC = process.env.Z2M_BASE_TOPIC || "zigbee2mqtt";

const devices = new Map();
const states = new Map();

const mqttClient = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });

mqttClient.on("connect", () => {
  mqttClient.subscribe(`${BASE_TOPIC}/bridge/devices`);
  mqttClient.subscribe(`${BASE_TOPIC}/+`);
});

mqttClient.on("message", (topic, buf) => {
  const msg = buf.toString();
  if (topic === `${BASE_TOPIC}/bridge/devices`) {
    try {
      const list = JSON.parse(msg);
      devices.clear();
      for (const d of list) devices.set(d.friendly_name, d);
    } catch {}
    return;
  }
  const parts = topic.split("/");
  if (parts.length === 2 && parts[0] === BASE_TOPIC && parts[1] !== "bridge") {
    try {
      states.set(parts[1], JSON.parse(msg));
    } catch {}
  }
});

function publish(topic, payload) {
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, JSON.stringify(payload), (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

const server = new Server(
  { name: "zigbee", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_devices",
      description:
        "List all paired Zigbee devices with current state, model, and vendor",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set",
      description:
        "Control a Zigbee light. Provide any combination of state/brightness/color/color_temp/effect/transition.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Friendly name (e.g. 'light1') or 'all' to broadcast",
          },
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
          color_temp: {
            type: "number",
            minimum: 150,
            maximum: 500,
            description: "Mireds: 150=coolest, 500=warmest",
          },
          effect: {
            type: "string",
            enum: [
              "blink",
              "breathe",
              "okay",
              "channel_change",
              "finish_effect",
              "stop_effect",
              "colorloop",
              "stop_colorloop",
            ],
          },
          transition: {
            type: "number",
            minimum: 0,
            description: "Smooth transition in seconds",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "get_state",
      description: "Get the most recent reported state of a device",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "permit_join",
      description: "Enable Zigbee pairing mode",
      inputSchema: {
        type: "object",
        properties: {
          seconds: {
            type: "number",
            minimum: 0,
            maximum: 254,
            description: "How long to allow joins (default 254)",
          },
        },
      },
    },
    {
      name: "rename_device",
      description: "Change a device's friendly name",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
    {
      name: "remove_device",
      description: "Unpair a device from the network",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          force: {
            type: "boolean",
            description:
              "Force-remove even if the device doesn't respond (use for dead/unreachable devices)",
          },
        },
        required: ["name"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const reply = (text) => ({ content: [{ type: "text", text }] });
  const err = (text) => ({ content: [{ type: "text", text }], isError: true });

  try {
    if (name === "list_devices") {
      const out = [];
      for (const [fname, d] of devices) {
        if (d.type === "Coordinator") continue;
        out.push({
          friendly_name: fname,
          ieee_address: d.ieee_address,
          model: d.definition?.model,
          vendor: d.definition?.vendor,
          description: d.definition?.description,
          state: states.get(fname) ?? null,
        });
      }
      return reply(JSON.stringify(out, null, 2));
    }

    if (name === "set") {
      const { name: dev, ...rest } = args;
      if (!dev) return err("name is required");
      await publish(`${BASE_TOPIC}/${dev}/set`, rest);
      return reply(`Sent to ${dev}: ${JSON.stringify(rest)}`);
    }

    if (name === "get_state") {
      const s = states.get(args.name);
      return reply(s ? JSON.stringify(s, null, 2) : `No state for ${args.name}`);
    }

    if (name === "permit_join") {
      const time = args.seconds ?? 254;
      await publish(`${BASE_TOPIC}/bridge/request/permit_join`, { time });
      return reply(`Permit join enabled for ${time}s`);
    }

    if (name === "rename_device") {
      await publish(`${BASE_TOPIC}/bridge/request/device/rename`, {
        from: args.from,
        to: args.to,
      });
      return reply(`Renamed ${args.from} → ${args.to}`);
    }

    if (name === "remove_device") {
      await publish(`${BASE_TOPIC}/bridge/request/device/remove`, {
        id: args.name,
        force: args.force ?? false,
      });
      return reply(`Remove requested for ${args.name}`);
    }

    return err(`Unknown tool: ${name}`);
  } catch (e) {
    return err(`Error: ${e.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
