# zigbee-mcp

A Model Context Protocol server that exposes Zigbee2MQTT device control as typed tools for AI Harness (Claude code).

## Description

Zigbee2MQTT already does the heavy lifting: it bridges a Zigbee radio dongle to an MQTT broker. This project adds a thin MCP layer on top, so an LLM agent can control paired lights and sensors through structured tool calls (`set`, `get_state`, `list_devices`, …) instead of hand-crafted `mosquitto_pub` commands.

Built for a local, single-user setup where Zigbee2MQTT and Mosquitto run on the same machine as the AI Harness.

## Prerequisites

- **[Mosquitto](https://mosquitto.org/)** running on `localhost:1883` (default, no auth)
- **[Zigbee2MQTT](https://www.zigbee2mqtt.io/)** running with `base_topic: zigbee2mqtt` and at least one device paired
- **[Bun](https://bun.sh/) 1.4+**, which runs `server.ts` (TypeScript) as it is

## Installation

```bash
git clone <repo-url> zigbee-mcp
cd zigbee-mcp
bun install
```

Register the server to your AI Harness.

### For Claude Code,
Register the server in `~/.claude.json` under `mcpServers`:

```json
"zigbee": {
  "type": "stdio",
  "command": "C:\\path\\to\\bun.exe",
  "args": ["C:\\path\\to\\zigbee-mcp\\server.ts"],
  "env": {}
}
```

Restart Claude Code. The tools appear as `mcp__zigbee__*`.

## Configuration

Environment variables (optional):

| Var | Default | Notes |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | Broker URL |
| `Z2M_BASE_TOPIC` | `zigbee2mqtt` | Must match your Z2M config |

## Usage

Once registered, Claude can call:

- `list_devices`: paired devices with current state, model, vendor
- `set`: unified light control (any of `state`, `brightness`, `color`, `color_temp`, `effect`, `transition`)
- `get_state`: last reported state of one device
- `status`: whether the broker is connected and Zigbee2MQTT is online, and how many devices are paired
- `permit_join`: open the network for pairing
- `rename_device`: change a friendly name
- `remove_device`: unpair

### Example prompts

> turn light1 red

> list my zigbee devices

> set both lights to warm white at 50%

### Example `set` payload

```json
{
  "name": "light1",
  "state": "ON",
  "brightness": 200,
  "color": { "r": 255, "g": 120, "b": 0 },
  "transition": 2
}
```

Color temperature is in mireds (`150` = coolest, `500` = warmest). Effects: `blink`, `breathe`, `colorloop`, `stop_effect`, etc.

Commands are only sent while Zigbee2MQTT's retained `<base>/bridge/state` says `online`. The broker accepts a publish whether or not anything is listening, so without that check a command sent with Zigbee2MQTT down would look like it worked and change nothing. Instead the tool returns an error naming what's down.

## Tests

```bash
bun test
```

They drive the tools with a recording publish and start the server over stdio with no broker, so they need neither Mosquitto nor Zigbee2MQTT.

## Troubleshooting

- **`Not sent: Zigbee2MQTT isn't running`**: Zigbee2MQTT is down, or `Z2M_BASE_TOPIC` doesn't match; check `http://localhost:8080` or the Z2M log.
- **`Not sent: not connected to the MQTT broker`**: Mosquitto isn't running, or `MQTT_URL` is wrong.
- **Tool missing after edit**: restart Claude Code; MCP config is only read at startup.
