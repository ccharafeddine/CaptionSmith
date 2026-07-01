/* @refresh reload */
import { render } from "solid-js/web";

import "./tokens.css";
import "./app.css";
import App from "./App";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root not found");
}

render(() => <App />, root);
