class ApiError(Exception):
    def __init__(self, status, code, message, *, hint=None, detail=None):
        super().__init__(message)
        self.status = status
        self.body = {"error": {"code": code, "message": message, "hint": hint, "detail": detail}}


def not_found(label):
    return ApiError(404, "not_found", f"{label}不存在")


def conflict(message):
    return ApiError(409, "conflict", message)
