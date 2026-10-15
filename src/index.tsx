/* @refresh reload */
import { render } from "solid-js/web";

import "./tokens.css";
import "./smith/tokens.css";
import "./smith/components.css";
import "./app.css";
import "./smith/shell.css";
import App from "./App";

document.documentElement.dataset.app = "captionsmith";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root not found");
}

render(() => <App />, root);
