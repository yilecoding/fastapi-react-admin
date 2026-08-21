def fmt_bytes(size: float) -> str:
    s, factor = size, 1024
    for unit in ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z']:
        if abs(s) < factor:
            return f'{s:.2f} {unit}B'
        s /= factor
    return f'{s:.2f} YB'
