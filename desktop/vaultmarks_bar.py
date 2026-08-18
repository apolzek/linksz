#!/usr/bin/env python3
"""Vaultmarks — barra de busca estilo Spotlight.

Escolhe sozinho a view conforme o sistema:

    Linux   GTK3 (python3-gi, ja vem no GNOME)   -> vmbar_gtk.py
    macOS   Tkinter (vem junto com o Python)     -> vmbar_tk.py

Em ambos, a primeira instancia fica residente e escondida; o atalho global roda
o script de novo, que so "acorda" a que ja esta rodando — por isso a barra
aparece instantaneamente em vez de subir um Python a cada vez.

Uso:
    vaultmarks_bar.py            abre a barra (ou acorda a instancia existente)
    vaultmarks_bar.py --daemon   inicia residente e escondido (autostart)

Variaveis:
    VAULTMARKS_UI=gtk|tk         força um toolkit
    VAULTMARKS_NO_AUTOHIDE=1     nao esconde ao perder o foco
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import vmplatform  # noqa: E402


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)

    try:
        toolkit = vmplatform.pick_toolkit()
    except RuntimeError as err:
        print(f"vaultmarks: {err}", file=sys.stderr)
        return 1

    if toolkit == "gtk":
        import vmbar_gtk
        return vmbar_gtk.run(argv)

    import vmbar_tk
    return vmbar_tk.run(argv)


if __name__ == "__main__":
    sys.exit(main())
