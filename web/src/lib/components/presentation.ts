export function enableChartLinks(chart: HTMLElement): void {
  chart.querySelectorAll<SVGElement>("[aria-roledescription=\"point\"]").forEach((point) => {
    point.setAttribute("tabindex", "0");
    point.setAttribute("role", "link");
    point.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      point.dispatchEvent(new MouseEvent("click", { bubbles: true, view: window }));
    });
  });
}
