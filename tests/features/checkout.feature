# Sample feature for the fictional "Acme Shop" demo app. Tags auto-stamped: @area (feature) + @type (scenario).

@area:checkout
Feature: Checkout

  Background:
    Given I am signed in to Acme Shop
    And I have one item in my cart

  @type:happy @smoke
  Scenario: AQA-101 Complete a card checkout
    When I open the checkout
    And I enter a valid shipping address and card
    And I place the order
    Then I see an order-confirmation number

  @type:negative
  Scenario: AQA-102 An expired card is rejected
    When I open the checkout
    And I pay with an expired card
    Then the order is blocked with a clear "card expired" message

  @type:edge
  Scenario: AQA-103 The minimum order value is enforced
    When my cart total is below the minimum
    And I open the checkout
    Then checkout is blocked with the minimum-order notice

  @type:guard
  Scenario: AQA-104 Leaving checkout with unsaved address warns me
    When I open the checkout
    And I enter an address without placing the order
    And I navigate away
    Then I am warned about losing my details
