#!/usr/bin/env python3

from telemetry import telemetry


@telemetry("diminspect")
def inspect_image(image):
    print(f"Inspecting image: {image}")
    return f"result for {image}"


if __name__ == "__main__":
    result = inspect_image("test-image.png")
    print(result)
