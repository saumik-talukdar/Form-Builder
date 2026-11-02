import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "vitest";
import { fieldSchema, type Field } from "@fb/shared";
import { FormRenderer } from "./FormRenderer";

afterEach(cleanup);

const f = (raw: unknown): Field => fieldSchema.parse(raw);

const fields: Field[] = [
  f({ id: "name", type: "short_text", label: "Your name", required: true }),
  f({
    id: "age",
    type: "number",
    label: "Your age",
    integer: true,
    min: 0,
    max: 120,
  }),
  f({
    id: "color",
    type: "select",
    label: "Favourite colour",
    required: true,
    options: [
      { id: "red", label: "Red" },
      { id: "other", label: "Something else" },
    ],
  }),
  f({
    id: "which",
    type: "short_text",
    label: "Which one?",
    required: true,
    showIf: { fieldId: "color", op: "eq", value: "other" },
  }),
  f({
    id: "tags",
    type: "multi_select",
    label: "Tags",
    options: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
  }),
  f({ id: "score", type: "rating", label: "How did we do?", max: 5 }),
];

describe("FormRenderer", () => {
  it("shows a conditional question only when its condition is met", async () => {
    const user = userEvent.setup();
    render(<FormRenderer fields={fields} />);

    expect(screen.queryByText("Which one?")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Something else" }));
    expect(screen.getByText("Which one?")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Red" }));
    expect(screen.queryByText("Which one?")).toBeNull();
  });

  it("blocks submit, shows errors for required answers and focuses the first one", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormRenderer fields={fields} onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText("This field is required")).toHaveLength(2); // name + colour; "which" is hidden
    expect(screen.getByRole("status").textContent).toBe(
      "2 answers need attention.",
    );
    expect(document.activeElement).toBe(screen.getByLabelText(/Your name/));
  });

  it("clears an error as soon as the answer is fixed", async () => {
    const user = userEvent.setup();
    render(<FormRenderer fields={fields} onSubmit={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(screen.getAllByText("This field is required")).toHaveLength(2);
    await user.type(screen.getByLabelText(/Your name/), "Ada");
    expect(screen.getAllByText("This field is required")).toHaveLength(1);
  });

  it("submits clean, typed answers and drops hidden ones", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <FormRenderer
        fields={fields}
        onSubmit={onSubmit}
        submitLabel="Send answers"
      />,
    );

    await user.type(screen.getByLabelText(/Your name/), "  Ada ");
    await user.type(screen.getByLabelText(/Your age/), "36");
    await user.click(screen.getByRole("radio", { name: "Something else" }));
    await user.type(screen.getByLabelText(/Which one/), "teal");
    await user.click(screen.getByRole("radio", { name: "Red" })); // hides "which" again
    await user.click(screen.getByRole("checkbox", { name: "Alpha" }));
    await user.click(screen.getByRole("checkbox", { name: "Beta" }));
    await user.click(screen.getByRole("radio", { name: "4" }));
    await user.click(screen.getByRole("button", { name: "Send answers" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const [answers, meta] = onSubmit.mock.calls[0]!;
    expect(answers).toEqual({
      name: "Ada",
      age: 36,
      color: "red",
      tags: ["a", "b"],
      score: 4,
    });
    expect(typeof meta.startedAt).toBe("number");
    expect(meta.website).toBe("");
  });

  it("rejects out-of-range numbers with a clear message", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<FormRenderer fields={fields} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/Your name/), "Ada");
    await user.click(screen.getByRole("radio", { name: "Red" }));
    await user.type(screen.getByLabelText(/Your age/), "130");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/120/);
  });

  it("numbers only the questions that are visible", async () => {
    const user = userEvent.setup();
    const { container } = render(<FormRenderer fields={fields} />);
    const nums = () =>
      [...container.querySelectorAll(".q-num")].map((n) => n.textContent);
    expect(nums()).toEqual(["1.", "2.", "3.", "4.", "5."]);
    await user.click(screen.getByRole("radio", { name: "Something else" }));
    expect(nums()).toEqual(["1.", "2.", "3.", "4.", "5.", "6."]);
  });

  it("shows server-side errors next to the field", () => {
    render(
      <FormRenderer
        fields={fields}
        serverErrors={[{ fieldId: "name", message: "Already taken" }]}
      />,
    );
    expect(screen.getByText("Already taken")).toBeTruthy();
  });
});
