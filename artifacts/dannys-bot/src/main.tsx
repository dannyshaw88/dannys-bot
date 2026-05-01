import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

window.onbeforeunload = function() {
  return "Are you sure you want to exit? The bot will stop running.";
};

createRoot(document.getElementById("root")!).render(<App />);
