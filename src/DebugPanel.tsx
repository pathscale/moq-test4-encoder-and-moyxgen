import { Accessor, For, Show } from "solid-js";
import type { DiagEvent } from "./types";

interface DebugPanelProps {
  connectionStatus: Accessor<string>;
  roomName: Accessor<string>;
  publishingAudio: Accessor<boolean>;
  speakerOn: Accessor<boolean>;
  participantCount: Accessor<number>;
  pubRms: Accessor<number>;
  subRms: Accessor<number>;
  diagLog: Accessor<DiagEvent[]>;
}

export function DebugPanel(props: DebugPanelProps) {
  return (
    <div class="font-mono text-sm space-y-4">
      <div class="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div class="bg-gray-900 border border-gray-700 rounded p-2">
          <div class="text-gray-500 text-xs">Connection</div>
          <div
            class={
              props.connectionStatus() === "connected"
                ? "text-green-400"
                : "text-yellow-400"
            }
          >
            {props.connectionStatus()}
          </div>
        </div>
        <div class="bg-gray-900 border border-gray-700 rounded p-2">
          <div class="text-gray-500 text-xs">Room</div>
          <div>{props.roomName()}</div>
        </div>
        <div class="bg-gray-900 border border-gray-700 rounded p-2">
          <div class="text-gray-500 text-xs">Mic</div>
          <div
            class={props.publishingAudio() ? "text-green-400" : "text-red-400"}
          >
            {props.publishingAudio() ? "ON" : "OFF"}
          </div>
        </div>
        <div class="bg-gray-900 border border-gray-700 rounded p-2">
          <div class="text-gray-500 text-xs">Speaker</div>
          <div
            class={props.speakerOn() ? "text-green-400" : "text-red-400"}
          >
            {props.speakerOn() ? "ON" : "OFF"}
          </div>
        </div>
        <div class="bg-gray-900 border border-gray-700 rounded p-2">
          <div class="text-gray-500 text-xs">Participants</div>
          <div>{props.participantCount()}</div>
        </div>
      </div>

      <div>
        <div class="text-xs text-gray-500 mb-1">
          Pub Mic RMS:{" "}
          <span
            class={props.pubRms() > 0.01 ? "text-green-400" : "text-red-400"}
          >
            {props.pubRms().toFixed(3)}
          </span>
        </div>
        <div class="bg-gray-900 rounded h-4 overflow-hidden">
          <div
            class={`h-full transition-all duration-100 ${
              props.pubRms() > 0.01 ? "bg-blue-500" : "bg-red-900/30"
            }`}
            style={{ width: `${Math.min(props.pubRms() * 500, 100)}%` }}
          />
        </div>
      </div>

      <div>
        <div class="text-xs text-gray-500 mb-1">
          Sub Audio RMS:{" "}
          <span
            class={props.subRms() > 0.01 ? "text-green-400" : "text-red-400"}
          >
            {props.subRms().toFixed(3)}
          </span>
        </div>
        <div class="bg-gray-900 rounded h-4 overflow-hidden">
          <div
            class={`h-full transition-all duration-100 ${
              props.subRms() > 0.01 ? "bg-green-500" : "bg-red-900/30"
            }`}
            style={{ width: `${Math.min(props.subRms() * 500, 100)}%` }}
          />
        </div>
      </div>

      <div class="space-y-2">
        <h2 class="text-sm font-medium text-gray-400">Event Log</h2>
        <div class="bg-gray-900 border border-gray-700 rounded p-3 max-h-64 overflow-y-auto font-mono text-xs text-gray-400">
          <Show
            when={props.diagLog().length > 0}
            fallback={
              <p class="text-gray-500 italic">No events yet.</p>
            }
          >
            <For each={props.diagLog()}>
              {(event) => (
                <div
                  class={
                    event.tag === "audio"
                      ? "text-green-400"
                      : event.tag === "announced"
                        ? "text-blue-400"
                        : event.tag === "retry" || event.tag === "stall"
                          ? "text-yellow-400"
                          : event.msg.includes("ERROR") ||
                              event.msg.includes("stalled")
                            ? "text-red-400"
                            : "text-gray-400"
                  }
                >
                  <span class="text-gray-600">{event.t}ms</span>{" "}
                  <span class="text-gray-500">[{event.tag}]</span>{" "}
                  {event.msg}
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
