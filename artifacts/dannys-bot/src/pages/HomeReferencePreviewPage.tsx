import reelsHomeReference from "@assets/home_1787131461428.jpg";

export function HomeReferencePreviewPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "32px",
        background: "#111827",
        color: "#f9fafb",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <section style={{ textAlign: "center" }}>
        <h1 style={{ margin: "0 0 8px", fontSize: "24px" }}>
          View Feed Home reference
        </h1>
        <p style={{ margin: "0 0 24px", color: "#9ca3af" }}>
          Exact image used when pressing Home at tool start
        </p>
        <div
          style={{
            display: "inline-flex",
            padding: "24px",
            background: "#374151",
            borderRadius: "12px",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
          }}
        >
          <img
            src={reelsHomeReference}
            alt="View Feed Home button reference image"
            width={320}
            height={320}
            style={{ imageRendering: "pixelated", display: "block" }}
          />
        </div>
        <p style={{ margin: "20px 0 0", color: "#9ca3af", fontFamily: "monospace" }}>
          home_1787131461428.jpg
        </p>
      </section>
    </main>
  );
}