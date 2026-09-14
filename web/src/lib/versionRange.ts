import type { BenchmarkRecord } from "./data";
import { unique } from "./data";

interface VersionRangeElements {
  end: HTMLSelectElement;
  start: HTMLSelectElement;
}

function setOptions(select: HTMLSelectElement, versions: string[]): void {
  select.replaceChildren(
    ...versions.map((version) => {
      const option = document.createElement("option");
      option.value = version;
      option.textContent = version;
      return option;
    }),
  );
}

function recordsInRange(
  records: BenchmarkRecord[],
  versions: string[],
  start: string,
  end: string,
): BenchmarkRecord[] {
  const selectedVersions = new Set(
    versions.slice(versions.indexOf(start), versions.indexOf(end) + 1),
  );
  return records.filter((record) => record.version && selectedVersions.has(record.version));
}

export async function initializeVersionRange(
  records: BenchmarkRecord[],
  elements: VersionRangeElements,
  render: (records: BenchmarkRecord[]) => void | Promise<void>,
): Promise<void> {
  const versions = unique(records.map((record) => record.version));
  if (!versions.length) {
    elements.start.disabled = true;
    elements.end.disabled = true;
    await render([]);
    return;
  }

  setOptions(elements.start, versions);
  setOptions(elements.end, versions);
  elements.start.value = versions[0];
  elements.end.value = versions.at(-1) ?? versions[0];
  elements.start.disabled = versions.length === 1;
  elements.end.disabled = versions.length === 1;

  const update = (): Promise<void> => {
    return Promise.resolve(
      render(recordsInRange(records, versions, elements.start.value, elements.end.value)),
    );
  };
  elements.start.addEventListener("change", () => {
    if (versions.indexOf(elements.start.value) > versions.indexOf(elements.end.value)) {
      elements.end.value = elements.start.value;
    }
    update();
  });
  elements.end.addEventListener("change", () => {
    if (versions.indexOf(elements.end.value) < versions.indexOf(elements.start.value)) {
      elements.start.value = elements.end.value;
    }
    update();
  });
  await update();
}
