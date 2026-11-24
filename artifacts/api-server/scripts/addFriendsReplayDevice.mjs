import sharp from "sharp";

/** Only emulates Android/Snapchat responses. Tool decisions live in runAddFriends. */
export class AddFriendsReplayDevice {
  constructor({ model, nodes, width, height, emit, movementScale = 1, omitDismissFor }) {
    this.model = model;
    this.nodes = nodes;
    this.width = width;
    this.height = height;
    this.emit = emit;
    this.movementScale = movementScale;
    this.actions = [];
    this.swipes = [];
    this.omitDismissFor = omitDismissFor;
    this.operations = 0;
  }
  scene() { return { nodes: this.nodes, width: this.width, height: this.height }; }
  checkBudget() {
    if (++this.operations > 160) throw new Error("Replay stopped after 160 device operations; inspect the tool log for a loop.");
  }
  async dumpUi() {
    this.checkBudget();
    const top = this.model.listTopFor(this.scene());
    const bottom = this.height * 0.94;
    const hidden = new Set();
    for (const group of this.model.rowGroups(this.nodes)) {
      // The simulated device exposes the viewport, while retaining off-screen
      // rows internally so actual tool swipes can reveal them.
      const title = group.children.find(node => this.model.shortId(node) === "result-title");
      const name = title?.text || title?.desc;
      if (group.row.bounds[1] < top - 1 || group.row.bounds[1] >= bottom) {
        for (let i = group.index; i < group.end; i++) hidden.add(i);
      } else if (name === this.omitDismissFor) {
        for (let i = group.index + 1; i < group.end; i++) {
          if (this.model.shortId(this.nodes[i]) === "friend-cell-dismiss") hidden.add(i);
        }
      }
    }
    return this.model.serializeNodes(this.nodes.filter((node, index) =>
      !hidden.has(index) && node.bounds[1] >= 0 && node.bounds[3] <= this.height));
  }
  async getScreenSizeAsync() { return { w: this.width, h: this.height }; }
  loadNavigationCalibrationMap() { return null; }
  async isKeyboardShown() { return false; }
  async withInputTransaction(_serial, operation) { return operation(); }
  async keyevent(_serial, key) { throw new Error(`The live tool requested unsupported key ${key}; the replay did not fake success.`); }
  async tapCalibratedNavigationControlAtY() { throw new Error("This imported device has no navigation calibration."); }
  async tap(_serial, x, y, _actor, reason) {
    this.checkBudget();
    const group = this.model.rowGroups(this.nodes).find(({ row }) =>
      x >= row.bounds[0] && x <= row.bounds[2] && y >= row.bounds[1] && y <= row.bounds[3]);
    if (!group) throw new Error(`Tool tapped outside a contact at (${x},${y}): ${reason}`);
    const hit = group.children.find(node => {
      const id = this.model.shortId(node);
      return ["friend-cell-dismiss", "scu_search_action_button"].includes(id) &&
        x >= node.bounds[0] && x <= node.bounds[2] && y >= node.bounds[1] && y <= node.bounds[3];
    });
    if (!hit) throw new Error(`Tool tap (${x},${y}) missed Add/Hide: ${reason}`);
    const title = group.children.find(node => this.model.shortId(node) === "result-title");
    const name = title?.text || title?.desc;
    const action = this.model.shortId(hit) === "friend-cell-dismiss" ? "dismiss" : "add";
    if (action === "dismiss") this.nodes = this.model.dismissReplayContact(this.nodes, name, this.width);
    else {
      this.nodes = this.nodes.map((node, index) => index >= group.index && index < group.end &&
        this.model.shortId(node) === "scu_search_action_button" ? { ...node, text: "Snap", desc: "Snap" } : node);
    }
    this.actions.push({ action, name, x, y });
    this.emit({ type: "frame", kind: "tap", action, name, x, y, reason, nodes: this.nodes });
  }
  async swipe(_serial, x1, y1, x2, y2, durationMs = 300) {
    this.checkBudget();
    const dy = Math.round((y2 - y1) * this.movementScale);
    const members = new Set();
    for (const group of this.model.rowGroups(this.nodes)) {
      for (let index = group.index; index < group.end; index++) members.add(index);
    }
    this.nodes = this.nodes.map((node, index) => members.has(index) ? {
      ...node, bounds: [node.bounds[0], node.bounds[1] + dy, node.bounds[2], node.bounds[3] + dy],
    } : node);
    const gesture = { x1, y1, x2, y2, durationMs, contentMovement: dy };
    this.swipes.push(gesture);
    this.emit({ type: "frame", kind: "swipe", gesture, nodes: this.nodes });
  }
  async captureScreenPixels() {
    this.checkBudget();
    // Rasterize the same phone SVG displayed by React; the production pixel
    // detector receives pixels, never a hard-coded divider height.
    const svg = this.model.renderPhone(this.scene());
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: info.channels, pixels: data };
  }
}
