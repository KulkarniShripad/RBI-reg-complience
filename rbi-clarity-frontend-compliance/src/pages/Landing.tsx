import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Shield, MessageSquare, FileSearch, Upload } from "lucide-react";

const features = [
  {
    icon: MessageSquare,
    title: "AI-Powered Chat",
    description: "Ask questions about RBI circulars and get simplified, accurate explanations instantly.",
  },
  {
    icon: Upload,
    title: "Upload Circulars",
    description: "Upload new RBI circulars and keep your compliance database always up to date.",
  },
  {
    icon: FileSearch,
    title: "Browse Circulars",
    description: "Search, filter, and explore all uploaded circulars in one organized view.",
  },
  {
    icon: Shield,
    title: "Compliance Checker",
    description: "Validate transactions and accounts against current regulatory rules automatically.",
  },
];

const Landing = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <section
        className="relative min-h-[80vh] flex items-center justify-center px-6"
        style={{ background: "var(--hero-gradient)" }}
      >
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmZmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMyI+PHBhdGggZD0iTTM2IDE4YzEuNjU2IDAgMy0xLjM0NCAzLTNzLTEuMzQ0LTMtMy0zLTMgMS4zNDQtMyAzIDEuMzQ0IDMgMyAzem0wIDZjMS42NTYgMCAzLTEuMzQ0IDMtM3MtMS4zNDQtMy0zLTMtMyAxLjM0NC0zIDMgMS4zNDQgMyAzIDN6Ii8+PC9nPjwvZz48L3N2Zz4=')] opacity-50" />

        <div className="relative z-10 text-center max-w-3xl mx-auto animate-fade-in">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 px-4 py-1.5 mb-8">
            <Shield className="h-4 w-4 text-secondary" />
            <span className="text-sm text-primary-foreground/80 font-medium">
              RBI Compliance Made Simple
            </span>
          </div>

          <h1 className="font-display text-4xl sm:text-5xl md:text-6xl font-bold text-primary-foreground leading-tight mb-6">
            RBI Circular
            <span className="block text-secondary">Assistant</span>
          </h1>

          <p className="text-lg text-primary-foreground/70 max-w-xl mx-auto mb-10 leading-relaxed">
            Understand complex RBI regulations with AI-powered explanations.
            Upload circulars, check compliance, and stay ahead of regulatory changes.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              variant="hero"
              size="lg"
              className="text-base px-8 py-6"
              onClick={() => navigate("/dashboard")}
            >
              Get Started
            </Button>
            <Button
              variant="hero-outline"
              size="lg"
              className="text-base px-8 py-6"
              onClick={() => {
                document.getElementById("features")?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              Learn More
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-display text-3xl font-bold text-foreground text-center mb-4">
            Everything You Need
          </h2>
          <p className="text-muted-foreground text-center max-w-lg mx-auto mb-16">
            A complete toolkit for bank employees to navigate RBI regulations confidently.
          </p>

          <div className="grid sm:grid-cols-2 gap-6">
            {features.map((f, i) => (
              <div
                key={f.title}
                className="group rounded-xl border border-border bg-card p-6 transition-all duration-300 hover:shadow-[var(--card-hover-shadow)]"
                style={{ animationDelay: `${i * 100}ms` }}
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary mb-4 group-hover:bg-secondary/20 group-hover:text-secondary transition-colors">
                  <f.icon className="h-6 w-6" />
                </div>
                <h3 className="font-semibold text-foreground text-lg mb-2">{f.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 px-6 text-center text-muted-foreground text-sm">
        © {new Date().getFullYear()} RBI Circular Assistant. Built for banking compliance.
      </footer>
    </div>
  );
};

export default Landing;
