import { render, screen } from "@testing-library/react";
import App from "./App";

describe("App scaffold", () => {
  it("renders the placeholder heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /personal ai-powered apm/i })
    ).toBeInTheDocument();
  });

  it("matches snapshot", () => {
    const { container } = render(<App />);
    expect(container).toMatchSnapshot();
  });
});
