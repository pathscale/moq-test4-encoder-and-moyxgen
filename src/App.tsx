import { Router, Route, Navigate } from "@solidjs/router";
import { Encoder } from "./Encoder";
import { Player } from "./Player";

export default function App() {
  return (
    <Router>
      <Route path="/encoder/:roomName?" component={Encoder} />
      <Route path="/player/:roomName?" component={Player} />
      <Route path="*" component={() => <Navigate href="/encoder" />} />
    </Router>
  );
}
