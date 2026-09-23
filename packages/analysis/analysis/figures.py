"""Графики (matplotlib → PNG). Простой стиль без зависимости от темы просмотра:
светлая поверхность, тонкие оси и сетка, две категориальные краски F/P,
планки ошибок = бутстреп‑интервал медианы.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Sequence

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

from . import schema as S  # noqa: E402

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
BASELINE = "#c3c2b7"
# категориальные слоты (валидированный порядок): F — синий, P — оранжевый
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
MODE_COLOR = {"F": SERIES[0], "P": SERIES[1]}
MODE_LABEL = {"F": "F — полная загрузка", "P": "P — частичная загрузка"}

plt.rcParams.update(
    {
        "font.family": ["DejaVu Sans", "sans-serif"],
        "font.size": 10,
        "axes.edgecolor": BASELINE,
        "axes.linewidth": 0.8,
        "axes.labelcolor": INK_2,
        "xtick.color": INK_2,
        "ytick.color": INK_2,
        "text.color": INK,
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE,
        "savefig.dpi": 150,
        "legend.frameon": False,
    }
)


def _fmt_num(v: float, _pos: Any = None) -> str:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    if abs(v) >= 1e9:
        return f"{v / 1e9:.1f} млрд"
    if abs(v) >= 1e6:
        return f"{v / 1e6:.1f} млн"
    if abs(v) >= 100 or float(v).is_integer():
        return f"{v:,.0f}".replace(",", " ")
    return f"{v:.2f}"


def _style_axes(ax: plt.Axes) -> None:
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(BASELINE)
    ax.spines["bottom"].set_color(BASELINE)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.tick_params(length=0)
    ax.yaxis.set_major_formatter(FuncFormatter(_fmt_num))


def plot_grouped_bars(
    summary: pd.DataFrame,
    metric: str,
    out: str | Path,
    *,
    title: str | None = None,
    adapters: Sequence[str] = S.ADAPTERS,
    modes: Sequence[str] = S.MODES,
    budget: float | None = None,
) -> Path:
    """Столбцы по адаптерам, F и P рядом; планки — бутстреп‑интервал медианы."""
    spec = S.METRIC_BY_COLUMN.get(metric)
    label = spec.label_ru if spec else metric
    unit = spec.unit if spec else ""
    sub = summary[summary["metric"] == metric]
    fig, ax = plt.subplots(figsize=(7.2, 4.0))
    _style_axes(ax)
    n_modes = len(modes)
    width = 0.3
    x = np.arange(len(adapters))
    for j, mode in enumerate(modes):
        offs = (j - (n_modes - 1) / 2) * (width + 0.04)
        vals, lo, hi = [], [], []
        for a in adapters:
            r = sub[(sub["adapter"] == a) & (sub["mode"] == mode)]
            if r.empty or math.isnan(float(r["median"].iloc[0])):
                vals.append(np.nan)
                lo.append(0.0)
                hi.append(0.0)
            else:
                m = float(r["median"].iloc[0])
                vals.append(m)
                lo.append(max(0.0, m - float(r["ci_lo"].iloc[0])) if not math.isnan(float(r["ci_lo"].iloc[0])) else 0.0)
                hi.append(max(0.0, float(r["ci_hi"].iloc[0]) - m) if not math.isnan(float(r["ci_hi"].iloc[0])) else 0.0)
        bars = ax.bar(
            x + offs,
            [0 if math.isnan(v) else v for v in vals],
            width,
            color=MODE_COLOR.get(mode, SERIES[j % len(SERIES)]),
            label=MODE_LABEL.get(mode, mode),
            edgecolor=SURFACE,
            linewidth=1.5,
            zorder=3,
        )
        ax.errorbar(x + offs, [0 if math.isnan(v) else v for v in vals], yerr=[lo, hi], fmt="none", ecolor=INK_2, elinewidth=1.0, capsize=3, zorder=4)
        for b, v, h in zip(bars, vals, hi):
            if not math.isnan(v):
                ax.annotate(_fmt_num(v), (b.get_x() + b.get_width() / 2, v + h), xytext=(0, 3), textcoords="offset points", ha="center", va="bottom", fontsize=8, color=INK_2)
            else:
                ax.annotate("нет данных", (b.get_x() + b.get_width() / 2, 0), xytext=(0, 3), textcoords="offset points", ha="center", va="bottom", fontsize=7, color=MUTED)
    if budget is not None and not math.isnan(budget):
        ax.axhline(budget, color=MUTED, linewidth=1.0, linestyle=(0, (4, 3)), zorder=2)
        ax.annotate(f"бюджет {_fmt_num(budget)}", (0.995, budget), xycoords=("axes fraction", "data"), xytext=(0, 3), textcoords="offset points", ha="right", va="bottom", fontsize=8, color=MUTED, annotation_clip=False)
    ax.set_xticks(x)
    ax.set_xticklabels([f"адаптер {a}" for a in adapters])
    ax.set_ylabel(unit)
    ax.set_title(title or f"{label}, медиана и 95 % бутстреп‑интервал", loc="left", fontsize=11, color=INK)
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.12), ncol=2, fontsize=9)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return out


def plot_retained_steps(steps: pd.DataFrame, out: str | Path, *, adapters: Sequence[str] = S.ADAPTERS) -> Path:
    """Удерживаемые фигуры по шагам сценария: точки (прогон × шаг), цвет — режим, панель — адаптер."""
    present = [a for a in adapters if a in set(steps["adapter"].dropna())]
    if not present:
        present = list(adapters)
    fig, axes = plt.subplots(1, len(present), figsize=(3.2 * len(present) + 1.0, 3.6), sharey=True, squeeze=False)
    rng = np.random.default_rng(0)
    for ax, a in zip(axes[0], present):
        _style_axes(ax)
        g = steps[steps["adapter"] == a]
        for mode in S.MODES:
            gm = g[g["mode"] == mode].dropna(subset=["step", "retained_shapes"])
            if gm.empty:
                continue
            jitter = rng.uniform(-0.18, 0.18, size=len(gm))
            ax.scatter(gm["step"] + jitter, gm["retained_shapes"], s=28, color=MODE_COLOR[mode], alpha=0.65, edgecolors=SURFACE, linewidths=1.0, label=MODE_LABEL[mode], zorder=3)
        ax.set_title(f"адаптер {a}", loc="left", fontsize=10, color=INK)
        ax.set_xlabel("шаг сценария")
        ax.xaxis.set_major_locator(matplotlib.ticker.MaxNLocator(integer=True))
    axes[0][0].set_ylabel("удерживаемые фигуры, шт.")
    handles, labels = axes[0][0].get_legend_handles_labels()
    if not handles:
        for ax in axes[0]:
            handles, labels = ax.get_legend_handles_labels()
            if handles:
                break
    if handles:
        fig.legend(handles, labels, loc="lower left", ncol=2, fontsize=9, bbox_to_anchor=(0.02, -0.02))
    fig.suptitle("Удерживаемые записи по шагам (getRetained)", x=0.02, ha="left", fontsize=11, color=INK)
    fig.tight_layout(rect=(0, 0.06, 1, 0.95))
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return out


def plot_series_comparison(summaries: dict[str, pd.DataFrame], metric: str, out: str | Path) -> Path:
    """Сравнение серий: столбцы по конфигурациям, серии рядом (до 8 серий)."""
    spec = S.METRIC_BY_COLUMN.get(metric)
    label = spec.label_ru if spec else metric
    names = list(summaries)[:8]
    configs: list[str] = []
    for n in names:
        s = summaries[n]
        for c in s.loc[s["metric"] == metric, "config"].tolist():
            if c not in configs:
                configs.append(c)
    fig, ax = plt.subplots(figsize=(max(7.2, 1.1 * len(configs) + 2), 4.2))
    _style_axes(ax)
    x = np.arange(len(configs))
    k = len(names)
    width = min(0.8 / max(k, 1), 0.3)
    for j, n in enumerate(names):
        s = summaries[n]
        s = s[s["metric"] == metric].set_index("config")
        vals = [float(s["median"].get(c, np.nan)) for c in configs]
        lo = [max(0.0, v - float(s["ci_lo"].get(c, np.nan))) if not math.isnan(v) else 0.0 for v, c in zip(vals, configs)]
        hi = [max(0.0, float(s["ci_hi"].get(c, np.nan)) - v) if not math.isnan(v) else 0.0 for v, c in zip(vals, configs)]
        offs = (j - (k - 1) / 2) * (width + 0.02)
        present = [i for i, v in enumerate(vals) if not math.isnan(v)]
        ax.bar([x[i] + offs for i in present], [vals[i] for i in present], width, color=SERIES[j % len(SERIES)], label=n, edgecolor=SURFACE, linewidth=1.5, zorder=3)
        ax.errorbar([x[i] + offs for i in present], [vals[i] for i in present], yerr=[[lo[i] for i in present], [hi[i] for i in present]], fmt="none", ecolor=INK_2, elinewidth=1.0, capsize=2, zorder=4)
    ax.set_xticks(x)
    ax.set_xticklabels(configs, rotation=20, ha="right")
    ax.set_ylabel(spec.unit if spec else "")
    ax.set_title(f"{label} — сравнение серий (медиана, 95 % интервал)", loc="left", fontsize=11, color=INK)
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.28), ncol=min(k, 4), fontsize=9)
    ax.set_ylim(bottom=0)
    fig.tight_layout()
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return out
