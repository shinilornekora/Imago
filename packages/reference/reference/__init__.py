"""Независимый эталон (oracle) предметной модели стенда — SPEC §1, §6.

Пакет не имеет общих модулей с сервером: правила предметной области
реализованы здесь заново по тексту SPEC §1 и §2.3.
"""

from .model import (
    CommandError,
    CommandOutcome,
    DocumentError,
    ForbiddenTargetError,
    InvalidCommandError,
    ReferenceModel,
    RevisionMismatchError,
    TargetNotFoundError,
    load_commands,
    load_document,
)

__all__ = [
    "CommandError",
    "CommandOutcome",
    "DocumentError",
    "ForbiddenTargetError",
    "InvalidCommandError",
    "ReferenceModel",
    "RevisionMismatchError",
    "TargetNotFoundError",
    "load_commands",
    "load_document",
]
