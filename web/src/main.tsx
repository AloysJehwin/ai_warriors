import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { AppProvider } from "./lib/app";
import { useRoute } from "./lib/router";
import { Open } from "./pages/Open";
import { Passport } from "./pages/Passport";
import { SignerProvider } from "./lib/sign";
import { SignIn } from "./pages/SignIn";
import { Setup } from "./pages/Setup";
import { Shell } from "./Shell";
import type { Me, Meta, Status } from "./types";
import { ToastProvider } from "./ui/kit";
import { ThemeToggle } from "./ui/ThemeToggle";
import "./styles.css";

const lastSite = () => {
  try {
    return localStorage.getItem("ordo.site");
  } catch {
    return null;
  }
};
const saveSite = (id: string) => {
  try {
    localStorage.setItem("ordo.site", id);
  } catch {
    /* ignore */
  }
};

function Root() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Me>("/v1/me"), api.get<Meta>("/v1/meta"), api.get<Status>("/v1/status")])
      .then(([m, mt, st]) => {
        setMe(m);
        setMeta(mt);
        setStatus(st);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    if (!me?.memberships.length) return;
    const pick = me.memberships.find((m) => m.siteId === (siteId ?? lastSite()))?.siteId ?? me.memberships[0]!.siteId;
    if (pick !== siteId) setSiteId(pick);
  }, [me, siteId]);

  const signOut = async () => {
    await api.post("/v1/auth/logout").catch(() => undefined);
    window.location.hash = "";
    window.location.reload();
  };

  // a lot's public passport (the QR code on a shipped lot) needs no account
  if (route.page === "passport" && route.id) return <Passport runId={route.id} />;
  // running pipelines are public too: a newcomer browses them and applies for a role
  if (route.page === "open") return <Open route={route} me={me} onSignedIn={setMe} />;
  if (error)
    return (
      <div className="boot">
        <p>Could not reach the Ordo API: {error}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  if (!me || !meta || !status) return <div className="boot">Loading…</div>;
  if (!me.user) return <SignIn onSignedIn={setMe} />;
  // a join link (#/join?site=…) opens the application form for members of other sites too
  if (!me.memberships.length || !siteId || route.page === "join")
    return (
      <Setup
        me={me}
        onSignOut={signOut}
        onCreated={async (id) => {
          saveSite(id);
          setMe(await api.get<Me>("/v1/me"));
          setSiteId(id);
          window.location.hash = "#/floor";
        }}
      />
    );
  return (
    <AppProvider key={siteId} me={me} setMe={setMe} siteId={siteId} meta={meta} status={status}>
      <SignerProvider address={me.user.address} trust={status.trust}>
        <Shell
          onSignOut={signOut}
          onSwitchSite={(id) => {
            saveSite(id);
            setSiteId(id);
            window.location.hash = "#/pipelines";
          }}
        />
      </SignerProvider>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <Root />
      <ThemeToggle floating />
    </ToastProvider>
  </StrictMode>,
);
