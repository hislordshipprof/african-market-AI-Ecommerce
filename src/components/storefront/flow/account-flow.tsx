"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { editorial } from "@/lib/storefront/editorial";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createDemoServices } from "@/lib/customer-flow/demo-adapters";
import { authClient } from "@/lib/auth-client";
import type {
  CustomerProfile,
  FlowAddress,
  FlowCatalogItem,
  FlowOrder,
  FlowStore,
} from "@/lib/customer-flow/contracts";
import type { CustomerProfile as RealCustomerProfile } from "@/lib/customer-auth";
import { Button, EmptyState } from "../primitives";
import {
  AddressCard,
  ClosedFlow,
  DemoNotice,
  FlowCard,
  FlowError,
  FlowHeading,
  FlowLoading,
} from "./common";
import { OrderFlow, statusLabel } from "./order-flow";
import { FlowToast } from "./feedback";
import "./account.css";
type Props = {
  settings: FlowStore;
  catalog: FlowCatalogItem[];
  enabled: boolean;
  customer?: RealCustomerProfile | null;
};
const message = (e: unknown) =>
  e instanceof Error ? e.message : "Something went wrong. Please try again.";
function useServices({ settings, catalog, enabled }: Props) {
  return useMemo(
    () => (enabled ? createDemoServices(settings, catalog, true) : null),
    [settings, catalog, enabled],
  );
}
export function AccountSignIn(props: Props) {
  const router = useRouter();
  const services = useServices(props);
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [destination, setDestination] = useState("");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!services) return;
    setBusy(true);
    setError("");
    try {
      if (challenge) {
        await services.auth.verify(challenge, code);
        router.push("/account");
      } else {
        const c = await services.auth.requestCode(channel, destination);
        setChallenge(c.challengeId);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!services) return <ClosedFlow />;
  return (
    <div className="sf-account">
      <FlowHeading
        title="Welcome back"
        description="Your markets. Your familiar favorites."
        backHref="/account"
        backLabel="Account"
      />
      <DemoNotice />
      <div className="sf-account-signin">
        <div className="sf-account-story">
          <Image
            src={editorial.market}
            alt="Fresh produce at a neighborhood market"
            fill
            sizes="(max-width:700px) 100vw, 480px"
          />
          <div>
            <span>Your neighborhood, your table</span>
            <h2>
              A taste of home.
              <br />A market that knows you.
            </h2>
            <p>Good food brings us back together.</p>
          </div>
        </div>
        <FlowCard
          title={challenge ? "Check your demo code" : "Sign in to your account"}
        >
          <p>
            Your demo profile is shared across markets in this browser. Messages
            are simulated.
          </p>
          {error && <FlowError message={error} />}
          <form onSubmit={submit} className="sf-account-form">
            {!challenge ? (
              <>
                <label>
                  Sign-in method
                  <select
                    value={channel}
                    onChange={(e) =>
                      setChannel(e.target.value as "sms" | "email")
                    }
                  >
                    <option value="sms">Phone / SMS</option>
                    <option value="email">Email magic link</option>
                  </select>
                </label>
                <label>
                  {channel === "sms" ? "Phone number" : "Email address"}
                  <input
                    required
                    type={channel === "sms" ? "tel" : "email"}
                    autoComplete={channel === "sms" ? "tel" : "email"}
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <p>
                  No message was sent. Use demo code <strong>123456</strong> for{" "}
                  {destination}. This code expires in ten minutes.
                </p>
                <label>
                  Verification code
                  <input
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="sf-text-link"
                  onClick={() => {
                    setChallenge("");
                    setCode("");
                  }}
                >
                  Use a different phone or email
                </button>
              </>
            )}
            <Button disabled={busy}>
              {busy
                ? "Please wait..."
                : challenge
                  ? "Verify and continue"
                  : channel === "sms"
                    ? "Get demo code"
                    : "Simulate email magic link"}
            </Button>
          </form>
        </FlowCard>
      </div>
    </div>
  );
}
export function AccountFlow(props: Props) {
  const router = useRouter();
  const services = useServices(props);
  const { customer } = props;
  const realProfile: CustomerProfile | null = customer
    ? {
        id: customer.id,
        name: customer.name,
        phone: customer.phone ?? "",
        email: customer.email ?? "",
        addresses: [],
      }
    : null;
  const [profile, setProfile] = useState<CustomerProfile | null>(realProfile);
  const [orders, setOrders] = useState<FlowOrder[]>([]);
  const [loading, setLoading] = useState(!customer);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FlowAddress[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (customer || !services) return;
    let active = true;
    Promise.all([services.auth.profile(), services.tracking.list()])
      .then(([p, o]) => {
        if (active) {
          setProfile(p);
          setOrders(o.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [services, customer]);
  async function save(next: CustomerProfile) {
    if (!services) return;
    setBusy(true);
    setError("");
    try {
      setProfile(await services.auth.saveProfile(next));
      setSaved("Profile saved in this browser.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!services) return;
    setBusy(true);
    setError("");
    try {
      setResults(await services.addresses.search(query));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!customer && !services) return <ClosedFlow />;
  return (
    <div className="sf-account">
      <FlowHeading
        title="Your account"
        description="A little home for your market life."
      />
      {!customer && <DemoNotice />}
      {error && <FlowError message={error} />}
      <FlowToast message={saved} onClose={() => setSaved("")} />
      {loading ? (
        <FlowLoading />
      ) : (
        <>
          {!profile ? (
            <FlowCard title="Make yourself at home">
              <p>
                Sign in to keep a demo profile and saved addresses across
                markets in this browser.
              </p>
              <Link href="/account/sign-in" className="sf-button">
                Sign in
              </Link>
            </FlowCard>
          ) : (
            <div className="sf-account-grid">
              <FlowCard title="Personal details">
                <form
                  className="sf-account-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!customer) void save(profile);
                  }}
                >
                  <label>
                    Name
                    <input
                      required
                      autoComplete="name"
                      value={profile.name}
                      readOnly={!!customer}
                      onChange={(e) =>
                        setProfile({ ...profile, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      type="tel"
                      autoComplete="tel"
                      value={profile.phone}
                      readOnly={!!customer}
                      onChange={(e) =>
                        setProfile({ ...profile, phone: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Email
                    <input
                      type="email"
                      autoComplete="email"
                      value={profile.email}
                      readOnly={!!customer}
                      onChange={(e) =>
                        setProfile({ ...profile, email: e.target.value })
                      }
                    />
                  </label>
                  {!customer && <Button disabled={busy}>Save details</Button>}
                  <button
                    type="button"
                    className="sf-text-link"
                    onClick={async () => {
                      if (customer) {
                        await authClient.signOut();
                        router.push("/account/sign-in");
                        return;
                      }
                      await services?.auth.signOut();
                      setProfile(null);
                      setSaved("Signed out of your demo account.");
                    }}
                  >
                    Sign out
                  </button>
                </form>
              </FlowCard>
              <FlowCard title="Saved addresses">
                <div className="sf-account-list">
                  {profile.addresses.map((a) => (
                    <article className="sf-account-address" key={a.id}>
                      <AddressCard address={a} title={a.label} />
                      <div className="sf-account-actions">
                        <button
                          className="sf-text-link"
                          onClick={() => {
                            setEditing(a.id);
                            setQuery(a.street);
                            setResults([]);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          className="sf-text-link"
                          onClick={() =>
                            void save({
                              ...profile,
                              addresses: profile.addresses.filter(
                                (x) => x.id !== a.id,
                              ),
                            })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                  {!profile.addresses.length && <p>No saved addresses yet.</p>}
                </div>
                <form onSubmit={search} className="sf-account-form">
                  <label>
                    {editing ? "Replace saved address" : "Add a demo address"}
                    <input
                      required
                      minLength={3}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Street address"
                    />
                  </label>
                  <Button disabled={busy}>Look up demo address</Button>
                  {editing && (
                    <button
                      type="button"
                      className="sf-text-link"
                      onClick={() => {
                        setEditing(null);
                        setQuery("");
                        setResults([]);
                      }}
                    >
                      Cancel edit
                    </button>
                  )}
                </form>
                {results.map((a) => (
                  <button
                    className="sf-account-address-result"
                    key={a.id}
                    onClick={() => {
                      void save({
                        ...profile,
                        addresses: [
                          ...profile.addresses.filter((x) => x.id !== editing),
                          { ...a, id: editing ?? a.id },
                        ],
                      });
                      setResults([]);
                      setQuery("");
                      setEditing(null);
                    }}
                  >
                    {a.street}, {a.city}, {a.state} {a.zip}
                    <small>Save this simulated address</small>
                  </button>
                ))}
              </FlowCard>
            </div>
          )}
          <FlowCard title={`Orders from ${props.settings.name}`}>
            <p>
              Order history is limited to this market and browser. Your demo
              profile is shared across markets.
            </p>
            {orders.length ? (
              <div className="sf-account-list">
                {orders.map((o) => (
                  <Link
                    className="sf-account-order"
                    href={`/account/orders/${encodeURIComponent(o.id)}`}
                    key={o.id}
                  >
                    <span>
                      <strong>{o.number}</strong>
                      <small>
                        {new Date(o.createdAt).toLocaleDateString()} ...{" "}
                        {o.lines.length}{" "}
                        {o.lines.length === 1 ? "item" : "items"}
                      </small>
                    </span>
                    <span>
                      {statusLabel(o.status)}
                      <small>
                        {new Intl.NumberFormat("en-US", {
                          style: "currency",
                          currency: "USD",
                        }).format((o.finalCents ?? o.quote.totalCents) / 100)}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Your first market haul awaits"
                description="Your demo orders from this market will appear here."
              >
                <Link href="/" className="sf-button">
                  Explore the market
                </Link>
              </EmptyState>
            )}
          </FlowCard>
        </>
      )}
    </div>
  );
}
export function AccountOrderDetail(
  props: Props & {
    id: string;
  },
) {
  const services = useServices(props);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!services) return;
    let active = true;
    services.tracking
      .list()
      .then((orders) => {
        if (active)
          setToken(orders.find((o) => o.id === props.id)?.token ?? null);
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [services, props.id]);
  if (!services) return <ClosedFlow />;
  if (loading) return <FlowLoading />;
  if (error || !token)
    return (
      <div className="sf-account">
        <FlowHeading
          title="Order unavailable"
          backHref="/account"
          backLabel="Your account"
        />
        <FlowError
          message={
            error || "This order is not available in this market and browser."
          }
        />
      </div>
    );
  return (
    <OrderFlow
      token={token}
      settings={props.settings}
      catalog={props.catalog}
      enabled={props.enabled}
    />
  );
}
